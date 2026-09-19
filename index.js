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

const MAX_TRIES   = 3;     // MRAM কে সর্বোচ্চ কতবার চেষ্টা করবে
const TIMEOUT_MS  = 12000; // একেকটা চেষ্টার জন্য সর্বোচ্চ অপেক্ষা (cold start কভার করার মতো যথেষ্ট)
const RETRY_DELAY = 1500;  // দুই চেষ্টার মাঝে বিরতি

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

/* MRAM কে একবার কল করে raw text ফেরত দেয়, timeout/network এ throw করে */
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
   invalid number ইত্যাদি) — আগের কোড সেটাকেও "OK" ধরে নিত। এখানে
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

  var lastErr = null;

  for (var attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      log("send-otp attempt " + attempt + "/" + MAX_TRIES + " -> " + apiMobile);
      var text = await callMram(url);
      log("MRAM raw reply:", text);

      if (!mramReplyLooksSuccessful(text)) {
        // HTTP 200 কিন্তু MRAM নিজেই বলছে পাঠাতে পারেনি (ব্যালেন্স/নম্বর সমস্যা)
        // — এটা retry করলে ঠিক হবে না, তাই সাথে সাথে থেমে আসল কারণ ফেরত দেওয়া হচ্ছে।
        log("MRAM reported failure inside 200 response — not retrying");
        return res.json({ status: "ERROR", error: "MRAM: " + text.slice(0, 200), raw: text });
      }

      var match = text.match(/ID\s*-\s*(\S+)/i);
      var extractedId = match ? match[1] : text.trim();
      return res.json({ status: "OK", raw: text, msgid: extractedId });

    } catch (e) {
      lastErr = e;
      var isTimeout = e.name === "AbortError";
      log("attempt " + attempt + " failed:", isTimeout ? "TIMEOUT after " + TIMEOUT_MS + "ms" : e.message);
      if (attempt < MAX_TRIES) await sleep(RETRY_DELAY);
    }
  }

  log("send-otp — all attempts failed for", apiMobile, lastErr && lastErr.message);
  return res.status(502).json({
    status: "ERROR",
    error: (lastErr && lastErr.message) || ("unknown network error after " + MAX_TRIES + " attempts")
  });
});

app.get("/", function (req, res) { res.send("Victor SMS Proxy — Online"); });
app.get("/ping", function (req, res) { res.send("pong"); });

app.listen(process.env.PORT || 3000, function () { log("SMS Proxy running"); });
