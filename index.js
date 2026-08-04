const express = require("express");
const app = express();
app.use(express.json());

// CORS — browser থেকে সরাসরি call করার জন্য
app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const API_KEY   = "C30005486a71785e35cac1.32484579";
const SENDER_ID = "VICTOR";

app.post("/send-otp", async (req, res) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp) return res.json({ status: "ERROR", error: "missing params" });

  const msg = `Your OTP is ${otp}. Valid 3 minutes.`;
  const url = `https://sms.mram.com.bd/smsapi?api_key=${API_KEY}&type=text&contacts=${mobile}&senderid=${SENDER_ID}&msg=${encodeURIComponent(msg)}`;

  try {
    const r    = await fetch(url);
    const text = await r.text();
    res.json({ status: "OK", raw: text });
  } catch (e) {
    res.json({ status: "ERROR", error: e.message });
  }
});

app.get("/", (req, res) => res.send("Victor SMS Proxy — Online"));
app.get("/ping", (req, res) => res.send("pong"));

app.listen(process.env.PORT || 3000, () => console.log("SMS Proxy running"));
