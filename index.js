const express = require("express");
const app = express();
app.use(express.json());

// CORS — browser থেকে সরাসরি call করার জন্য
app.use(function (req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// আগে হার্ডকোড করা ছিল — এখন চাইলে Render এর Environment Variables থেকেও
// সেট করা যাবে (নাম: MRAM_API_KEY, MRAM_SENDER_ID)। env var সেট না করলে
// নিচের ভ্যালুই ব্যবহার হবে — অর্থাৎ কিছু বদলাতে না চাইলে আগের মতোই কাজ করবে।
const API_KEY   = process.env.MRAM_API_KEY || "C300054864c761b9023510.16858542";
const SENDER_ID = process.env.MRAM_SENDER_ID || "VICTOR";

// v7.0 Code.gs অনুযায়ী: OTP এখন ONE ATTEMPT-এই পাঠানো হয়, এই proxy লেয়ারে
// কোনো retry/cooldown/lock নেই। এই timeout-টা শুধু "কতক্ষণ MRAM-এর উত্তরের
// জন্য অপেক্ষা করবো" সেটা ঠিক করে — এখানে retry করলে MRAM-এ প্রথম SMS আসলে
// চলে গিয়ে থাকলেও দ্বিতীয়টা আবার পাঠানো হয়ে যেতে পারে (duplicate SMS)।
// Code.gs নিজেই এই একই কারণে server-side retry বাদ দিয়েছে — এই proxy সেই
// একই contract মেনে চলছে।
const TIMEOUT_MS = 15000;

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

/* ফোন নম্বর সবসময় "880XXXXXXXXXX" ফরম্যাটে MRAM-কে পাঠানো হচ্ছে কিনা নিশ্চিত করা।
   কিছু sheet row-এ leading zero ছাড়া নম্বর সেভ হয়ে গেছে (যেমন "1770139700"
   এর বদলে হওয়ার কথা ছিল "01770139700") — BD মোবাইল নম্বর সবসময়
   01[3-9]XXXXXXXX প্যাটার্নে হয়, তাই ১০ সংখ্যার এমন নম্বর পেলে এখানেও
   auto-correct করা হচ্ছে (Code.gs-এ একই ফিক্স আছে, এটা দ্বিতীয় স্তরের সুরক্ষা)। */
function normalizeApiMobile(raw) {
  var digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.indexOf("880") === 0 && digits.length === 13) return digits;
  if (digits.indexOf("0") === 0 && digits.length === 11) return "880" + digits.substring(1);
  if (digits.length === 10 && /^1[3-9]/.test(digits)) return "880" + digits; // missing leading 0
  return digits;
}

/* MRAM-কে একবার কল করে raw text ফেরত দেয়, timeout/network এ throw করে */
async function callMram(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    var r = await fetch(url, { signal: controller.signal });
    var text = await r.text();
    if (!r.ok) throw new Error("MRAM HTTP " + r.status + " — " + text.slice(0, 200));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* MRAM অনেক সময় HTTP 200 দিয়েই ভেতরে error message পাঠায় (balance শেষ,
   invalid number ইত্যাদি) — সেটাকে "OK" ধরে নেওয়া যাবে না। এখানে
   আসলেই SMS জমা হয়েছে কিনা যাচাই করা হচ্ছে। */
function mramReplyLooksSuccessful(text) {
  var t = String(text || "");
  if (/SUBMITTED/i.test(t)) return true;
  if (/ID\s*-\s*\S+/i.test(t)) return true;
  return false;
}

app.post("/send-otp", async function (req, res) {
  var body   = req.body || {};
  var mobile = body.mobile;
  var otp    = body.otp;

  if (!mobile || !otp) {
    log("send-otp rejected — missing params", body);
    return res.status(400).json({ status: "ERROR", error: "missing params (mobile/otp)" });
  }

  var apiMobile = normalizeApiMobile(mobile);
  if (apiMobile.length < 12) {
    log("send-otp rejected — bad mobile format", mobile, "->", apiMobile);
    return res.status(400).json({ status: "ERROR", error: "invalid mobile format: " + mobile });
  }

  var msg = "Your OTP is " + otp + ". Valid 3 minutes.";
  var url =
    "https://sms.mram.com.bd/smsapi?api_key=" + API_KEY + "&type=text" +
    "&contacts=" + apiMobile + "&senderid=" + SENDER_ID + "&msg=" + encodeURIComponent(msg);

  // ── ONE ATTEMPT ONLY — কোনো retry loop নেই (দেখো উপরের TIMEOUT_MS নোট) ──
  try {
    log("send-otp -> " + apiMobile);
    var text = await callMram(url);
    log("MRAM raw reply:", text);

    if (!mramReplyLooksSuccessful(text)) {
      // HTTP 200 কিন্তু MRAM নিজেই বলছে পাঠাতে পারেনি (ব্যালেন্স/নম্বর সমস্যা)।
      // Code.gs এটাকে MRAM_REJECTED হিসেবে classify করবে (HTTP 200 রাখা হচ্ছে
      // ইচ্ছাকৃতভাবে, যাতে PROXY_DOWN বলে ভুল classify না হয়)।
      log("MRAM reported failure inside 200 response");
      return res.json({ status: "ERROR", error: "MRAM: " + text.slice(0, 200), raw: text });
    }

    var match = text.match(/ID\s*-\s*(\S+)/i);
    var extractedId = match ? match[1] : text.trim();
    return res.json({ status: "OK", raw: text, msgid: extractedId });

  } catch (e) {
    var isTimeout = e.name === "AbortError";
    log("send-otp failed:", isTimeout ? "TIMEOUT after " + TIMEOUT_MS + "ms" : e.message);
    // 502/503/504/429/0 — এই যেকোনো একটা status দিলেই Code.gs (sendSmsViaProxy)
    // একে PROXY_DOWN হিসেবে ধরে নেয়, যেটা সঠিক: proxy MRAM-এ পৌঁছাতে পারেনি।
    return res.status(502).json({
      status: "ERROR",
      error: isTimeout
        ? "MRAM request timed out after " + TIMEOUT_MS + "ms"
        : (e.message || "unknown network error")
    });
  }
});

app.get("/", function (req, res) { res.send("Victor SMS Proxy — Online"); });
app.get("/ping", function (req, res) { res.send("pong"); });

app.listen(process.env.PORT || 3000, function () { log("SMS Proxy running"); });
