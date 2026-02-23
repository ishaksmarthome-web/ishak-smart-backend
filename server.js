/*****************************************************
 * ISHAK SMART HOME - ULTRA PRODUCTION BACKEND
 * MQTT + Firebase + Auth + Device Share
 * Template + Capability + Admin + Dashboard
 *****************************************************/

const mqtt = require("mqtt");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

const PORT = process.env.PORT || 5000;

/* ====================================================
   FIREBASE INIT (DUAL MODE)
==================================================== */

let serviceAccount;

if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  console.log("🔐 Using Firebase Env Key");
} else {
  serviceAccount = require("./serviceAccount.json");
  console.log("🔐 Using Local serviceAccount.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ishak-smart-home-a36bd-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

/* ====================================================
   EXPRESS
==================================================== */

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("🔥 Ishak Smart Backend Running");
});

/* ====================================================
   🔴 ADMIN MIDDLEWARE
==================================================== */

async function isAdmin(req, res, next) {

  try {

    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No Token" });

    const decoded = await admin.auth().verifyIdToken(token);

    const snap = await db.ref("users/" + decoded.uid).once("value");
    const user = snap.val();

    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin Only" });
    }

    req.user = decoded;
    next();

  } catch (err) {

    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ====================================================
   USER REGISTER
==================================================== */

app.post("/register", async (req, res) => {

  try {

    const { email, password } = req.body;

    const user = await admin.auth().createUser({
      email,
      password
    });

    await db.ref("users/" + user.uid).set({
      email,
      role: "user",
      createdAt: Date.now(),
      devices: []
    });

    res.json({ success: true });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* ====================================================
   AUTO DEVICE REGISTER
==================================================== */

app.post("/auto-register-device", async (req, res) => {

  try {

    const { deviceId, deviceSecret } = req.body;

    const ref = db.ref("devices/" + deviceId);
    const snap = await ref.once("value");

    if (snap.exists()) {
      return res.json({ message: "Already Registered" });
    }

    await ref.set({
      secret: deviceSecret,
      owner: null,
      status: "OFFLINE",
      createdAt: Date.now(),
      capabilities: null,
      template: null,
      sharedWith: {}
    });

    res.json({ success: true });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* ====================================================
   TEMPLATE SYSTEM
==================================================== */

/* Create / Update Template */
app.post("/template", isAdmin, async (req, res) => {

  try {

    const { templateId, config } = req.body;

    await db.ref("templates/" + templateId).set({
      ...config,
      updatedAt: Date.now()
    });

    res.json({ success: true });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* Get Templates */
app.get("/templates", async (req, res) => {

  const snap = await db.ref("templates").once("value");

  res.json({
    success: true,
    templates: snap.val() || {}
  });

});

/* ====================================================
   DEVICE SHARE
==================================================== */

app.post("/share-device", async (req, res) => {

  try {

    const { deviceId, ownerUid, targetUid } = req.body;

    const ref = db.ref("devices/" + deviceId);
    const snap = await ref.once("value");
    const device = snap.val();

    if (!device) {
      return res.status(404).json({ error: "Device Not Found" });
    }

    if (device.owner !== ownerUid) {
      return res.status(403).json({ error: "Only Owner Can Share" });
    }

    await ref.child("sharedWith").update({
      [targetUid]: true
    });

    res.json({ success: true });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* ====================================================
   UNSHARE
==================================================== */

app.post("/unshare-device", async (req, res) => {

  try {

    const { deviceId, ownerUid, targetUid } = req.body;

    const ref = db.ref("devices/" + deviceId);
    const snap = await ref.once("value");
    const device = snap.val();

    if (!device) return res.status(404).json({ error: "Not Found" });

    if (device.owner !== ownerUid) {
      return res.status(403).json({ error: "Not Owner" });
    }

    await ref.child("sharedWith/" + targetUid).remove();

    res.json({ success: true });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* ====================================================
   MQTT
==================================================== */

const client = mqtt.connect("mqtt://broker.emqx.io:1883", {
  reconnectPeriod: 5000
});

client.on("connect", () => {

  console.log("✅ MQTT Connected");

  client.subscribe("device/+/heartbeat");
  client.subscribe("device/+/status");
  client.subscribe("device/+/command");

});

/* ====================================================
   MQTT MESSAGE
==================================================== */

client.on("message", async (topic, message) => {

  console.log("📩 Topic:", topic);

  try {

    const payload = JSON.parse(message.toString());
    console.log("📦 Payload:", payload);

    const deviceId = topic.split("/")[1];
    console.log("🔵 Device ID:", deviceId);

    const ref = db.ref("devices/" + deviceId);

    await ref.update({
      status: "ONLINE",
      lastSeen: Date.now(),
      template: payload.template || null,
      capabilities: payload.capabilities || null,
      data: payload
    });

    console.log("🔥 Firebase Updated:", deviceId);

  } catch (err) {

    console.log("MQTT ERROR:", err.message);
  }

});

/* ====================================================
   COMMAND LISTENER
==================================================== */

db.ref("devices").on("child_changed", async (snapshot) => {

  const deviceId = snapshot.key;
  const data = snapshot.val();

  if (data?.command) {

    client.publish(
      `device/${deviceId}/command`,
      JSON.stringify({ cmd: data.command }),
      { qos: 1 }
    );

    await db.ref("devices/" + deviceId + "/command").set(null);
  }

});

/* ====================================================
   OFFLINE DETECTION
==================================================== */

setInterval(async () => {

  const snap = await db.ref("devices").once("value");
  const devices = snap.val() || {};

  for (const id of Object.keys(devices)) {

    const device = devices[id];

    if (device.lastSeen) {

      const diff = Date.now() - device.lastSeen;

      if (diff > 20000 && device.status !== "OFFLINE") {

        await db.ref("devices/" + id).update({
          status: "OFFLINE"
        });

      }
    }
  }

}, 10000);

/* ====================================================
   OTA
==================================================== */

app.get("/latest-firmware", async (req, res) => {

  const snap = await db.ref("firmware").once("value");

  res.json(snap.val() || {
    version: "1.0.0",
    fileUrl: "",
    forceUpdate: false
  });

});

app.post("/update-firmware", isAdmin, async (req, res) => {

  const { version, fileUrl, forceUpdate } = req.body;

  await db.ref("firmware").set({
    version,
    fileUrl,
    forceUpdate: forceUpdate || false,
    updatedAt: Date.now()
  });

  res.json({ success: true });

});

/* ====================================================
   DASHBOARD
==================================================== */

app.get("/dashboard/stats", isAdmin, async (req, res) => {

  const deviceSnap = await db.ref("devices").once("value");
  const devices = deviceSnap.val() || {};

  let online = 0;
  let offline = 0;

  Object.values(devices).forEach(d => {
    if (d.status === "ONLINE") online++;
    if (d.status === "OFFLINE") offline++;
  });

  const userSnap = await db.ref("users").once("value");
  const users = userSnap.val() || {};

  res.json({
    totalDevices: Object.keys(devices).length,
    onlineDevices: online,
    offlineDevices: offline,
    totalUsers: Object.keys(users).length
  });

});

/* ====================================================
   START SERVER
==================================================== */

app.listen(PORT, () => {
  console.log("🔥 Backend Running on Port", PORT);
});
