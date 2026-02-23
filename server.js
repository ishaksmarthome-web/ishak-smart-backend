/*****************************************************
 * ISHAK SMART HOME - FIREBASE ONLY BACKEND
 * No MQTT, Pure Firebase Realtime Database
 *****************************************************/

const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

const PORT = process.env.PORT || 5000;

/* ====================================================
   FIREBASE INIT
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
  res.send("🔥 Ishak Smart Backend (Firebase Only) Running");
});

/* ====================================================
   ADMIN MIDDLEWARE
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
    const user = await admin.auth().createUser({ email, password });

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
      capabilities: {
        relays: 4,
        fanSpeeds: 4,
        pwm: true
      },
      lights: {
        1: false,
        2: false,
        3: false,
        4: false
      },
      fanSpeed: 0,
      brightness: 200,
      lastSeen: Date.now(),
      sharedWith: {}
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ====================================================
   DIRECT DEVICE CONTROL API
==================================================== */

// Control Light
app.post("/control/light/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { lightId, state } = req.body; // lightId: 1-4, state: true/false

    await db.ref(`devices/${deviceId}/lights/${lightId}`).set(state);
    
    res.json({ 
      success: true, 
      message: `Light ${lightId} set to ${state}` 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Control All Lights
app.post("/control/all-lights/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { state } = req.body;

    const updates = {};
    for (let i = 1; i <= 4; i++) {
      updates[`lights/${i}`] = state;
    }

    await db.ref(`devices/${deviceId}`).update(updates);
    
    res.json({ success: true, message: `All lights set to ${state}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Control Fan Speed
app.post("/control/fan/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { speed } = req.body; // 0-4

    await db.ref(`devices/${deviceId}/fanSpeed`).set(speed);
    
    res.json({ success: true, message: `Fan speed set to ${speed}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Control Brightness
app.post("/control/brightness/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { value } = req.body; // 0-255

    await db.ref(`devices/${deviceId}/brightness`).set(value);
    
    res.json({ success: true, message: `Brightness set to ${value}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ====================================================
   TEMPLATE SYSTEM
==================================================== */

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

    if (!device) return res.status(404).json({ error: "Device Not Found" });
    if (device.owner !== ownerUid) return res.status(403).json({ error: "Only Owner Can Share" });

    await ref.child("sharedWith").update({ [targetUid]: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/unshare-device", async (req, res) => {
  try {
    const { deviceId, ownerUid, targetUid } = req.body;
    const ref = db.ref("devices/" + deviceId);
    const snap = await ref.once("value");
    const device = snap.val();

    if (!device) return res.status(404).json({ error: "Not Found" });
    if (device.owner !== ownerUid) return res.status(403).json({ error: "Not Owner" });

    await ref.child("sharedWith/" + targetUid).remove();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
   DASHBOARD STATS
==================================================== */

app.get("/dashboard/stats", isAdmin, async (req, res) => {
  const deviceSnap = await db.ref("devices").once("value");
  const devices = deviceSnap.val() || {};

  let online = 0, offline = 0;
  Object.values(devices).forEach(d => {
    const lastSeen = d.lastSeen || 0;
    if (Date.now() - lastSeen < 30000) online++;
    else offline++;
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
   GET DEVICE STATUS
==================================================== */

app.get("/device/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const snap = await db.ref("devices/" + deviceId).once("value");
    const device = snap.val();

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({ success: true, device });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      if (diff > 30000 && device.status !== "OFFLINE") {
        await db.ref("devices/" + id).update({
          status: "OFFLINE"
        });
      }
    }
  }
}, 10000);

/* ====================================================
   KEEP ALIVE
==================================================== */

setInterval(() => {
  console.log("🔥 Server Alive Check");
}, 30000);

/* ====================================================
   START SERVER
==================================================== */

app.listen(PORT, () => {
  console.log("🔥 Firebase Only Backend Running on Port", PORT);
});
