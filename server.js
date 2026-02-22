/*****************************************************
 *  ISHAK SMART HOME - PRODUCTION BACKEND (FINAL)
 *  MQTT + Firebase + Ownership Protection
 *****************************************************/

const mqtt = require("mqtt");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

/* ====================================================
   ENV VARIABLES
==================================================== */

const PORT = process.env.PORT || 5000;
const FIREBASE_KEY = JSON.parse(process.env.FIREBASE_KEY);

/* ====================================================
   FIREBASE INIT
==================================================== */

admin.initializeApp({
  credential: admin.credential.cert(FIREBASE_KEY),
  databaseURL: "https://ishak-smart-home-a36bd-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

/* ====================================================
   EXPRESS SETUP
==================================================== */

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("🔥 Ishak Smart Backend Running");
});

/* ====================================================
   MQTT CONNECTION
==================================================== */

const client = mqtt.connect("mqtt://broker.emqx.io:1883", {
  reconnectPeriod: 5000
});

client.on("connect", () => {
  console.log("✅ Connected to MQTT Broker");

  client.subscribe("device/+/heartbeat");
  client.subscribe("device/+/status");
  client.subscribe("device/+/command");

  console.log("📡 Subscribed to device topics");
});

/* ====================================================
   MQTT MESSAGE HANDLER
==================================================== */

client.on("message", async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split("/");
    const deviceId = parts[1];

    console.log("📥 Data from:", deviceId);

    const deviceRef = db.ref("devices/" + deviceId);
    const snapshot = await deviceRef.once("value");
    const deviceData = snapshot.val();

    // ✅ Device Must Exist
    if (!deviceData) {
      console.log("⚠ Device not registered:", deviceId);
      return;
    }

    // ✅ Ownership Protection
    if (!deviceData.owner) {
      console.log("⚠ Device has no owner:", deviceId);
      return;
    }

    // ✅ Update Device Status Securely
    await deviceRef.update({
      lastSeen: Date.now(),
      status: "ONLINE",
      data: payload
    });

    console.log("✅ Device Updated:", deviceId);

  } catch (err) {
    console.log("MQTT Error:", err.message);
  }
});

/* ====================================================
   FIREBASE → COMMAND LISTENER
==================================================== */

db.ref("devices").on("child_changed", async (snapshot) => {

  try {
    const deviceId = snapshot.key;
    const data = snapshot.val();

    if (data && data.command) {

      console.log("🚀 Command detected for:", deviceId);

      const topic = `device/${deviceId}/command`;

      client.publish(topic, JSON.stringify({
        cmd: data.command
      }), { qos: 1 });

      // ✅ Clear command after sending
      await db.ref("devices/" + deviceId + "/command").set(null);
    }

  } catch (err) {
    console.log("Command Listener Error:", err.message);
  }
});

/* ====================================================
   OFFLINE DETECTION (60 SEC RULE)
==================================================== */

setInterval(async () => {

  try {

    const snapshot = await db.ref("devices").once("value");
    const devices = snapshot.val();

    if (!devices) return;

    Object.keys(devices).forEach(async (deviceId) => {

      const device = devices[deviceId];

      if (device.lastSeen) {

        const diff = Date.now() - device.lastSeen;

        if (diff > 60000 && device.status !== "OFFLINE") {

          console.log("❌ Device OFFLINE:", deviceId);

          await db.ref("devices/" + deviceId).update({
            status: "OFFLINE"
          });
        }
      }

    });

  } catch (err) {
    console.log("Offline Check Error:", err.message);
  }

}, 10000);

/* ====================================================
   DEVICE REGISTRATION API
==================================================== */

app.post("/register-device", async (req, res) => {

  try {

    const { deviceId, ownerUid } = req.body;

    await db.ref("devices/" + deviceId).set({
      owner: ownerUid,
      status: "OFFLINE",
      lastSeen: null
    });

    res.json({
      success: true,
      message: "Device Registered Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

/* ====================================================
   START SERVER
==================================================== */

app.listen(PORT, () => {
  console.log("🔥 Backend Running on Port", PORT);
});
