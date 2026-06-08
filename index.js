const express = require("express");
const app = express();
app.use(express.json());

const API_KEY   = "C300054864c761b9023510.16858542";
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

app.listen(process.env.PORT || 3000, () => console.log("SMS Proxy running"));
