/*****************************************************
 * ISHAK SMART HOME - ULTRA PRODUCTION BACKEND
 * MQTT + Firebase + Auth + Device Share System
 * ✅ Admin Role Protection Added
 *****************************************************/

const mqtt = require("mqtt");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

/* ====================================================
   CONFIG
==================================================== */

const PORT = process.env.PORT || 5000;

/* ====================================================
   FIREBASE INIT (DUAL MODE)
==================================================== */

let serviceAccount;

if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  console.log("🔐 Using Firebase Key From Environment");
} else {
  serviceAccount = require("./serviceAccount.json");
  console.log("🔐 Using Local serviceAccount.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://ishak-smart-home-a36bd-default-rtdb.asia-southeast1.firebasedatabase.app"
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
   🔴 ADMIN MIDDLEWARE
==================================================== */

async function isAdmin(req, res, next) {

  try {

    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No Token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const snap = await db.ref("users/" + decoded.uid).once("value");
    const user = snap.val();

    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin Only Access" });
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

    const { email, password, deviceIds } = req.body;

    const user = await admin.auth().createUser({
      email,
      password
    });

    const uid = user.uid;

    console.log("👤 User Created:", uid);

    await db.ref("users/" + uid).set({
      email,
      role: "user",  // 🔵 Default Role
      createdAt: Date.now(),
      devices: deviceIds || []
    });

    if (deviceIds && Array.isArray(deviceIds)) {

      for (const deviceId of deviceIds) {

        await db.ref("devices/" + deviceId).update({
          owner: uid,
          status: "OFFLINE",
          lastSeen: null
        });

      }
    }

    res.json({
      success: true,
      uid,
      message: "User Registered Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});


/* ====================================================
   LOGIN
==================================================== */

app.post("/login", async (req, res) => {

  try {

    const { idToken } = req.body;

    const decoded = await admin.auth().verifyIdToken(idToken);

    const snap = await db.ref("users/" + decoded.uid).once("value");
    const user = snap.val();

    res.json({
      success: true,
      uid: decoded.uid,
      email: decoded.email,
      role: user?.role || "user"
    });

  } catch (err) {

    res.status(401).json({
      success: false,
      error: "Invalid Token"
    });

  }

});


/* ====================================================
   AUTO DEVICE REGISTER
==================================================== */

app.post("/auto-register-device", async (req, res) => {

  try {

    const { deviceId, deviceSecret } = req.body;

    const deviceRef = db.ref("devices/" + deviceId);
    const snapshot = await deviceRef.once("value");

    if (snapshot.val()) {
      return res.json({
        success: false,
        message: "Device Already Registered"
      });
    }

    await deviceRef.set({
      owner: null,
      secret: deviceSecret,
      status: "OFFLINE",
      lastSeen: null,
      createdAt: Date.now(),
      sharedWith: {}
    });

    res.json({
      success: true,
      message: "Device Auto Registered Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});


/* ====================================================
   DEVICE SHARE
==================================================== */

app.post("/share-device", async (req, res) => {

  try {

    const { deviceId, ownerUid, targetUid } = req.body;

    const deviceRef = db.ref("devices/" + deviceId);
    const snapshot = await deviceRef.once("value");
    const device = snapshot.val();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Device Not Found"
      });
    }

    if (device.owner !== ownerUid) {
      return res.status(403).json({
        success: false,
        message: "Only Owner Can Share"
      });
    }

    await deviceRef.child("sharedWith").update({
      [targetUid]: true
    });

    res.json({
      success: true,
      message: "Device Shared Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});


/* ====================================================
   DEVICE UNSHARE
==================================================== */

app.post("/unshare-device", async (req, res) => {

  try {

    const { deviceId, ownerUid, targetUid } = req.body;

    const deviceRef = db.ref("devices/" + deviceId);
    const snapshot = await deviceRef.once("value");
    const device = snapshot.val();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Device Not Found"
      });
    }

    if (device.owner !== ownerUid) {
      return res.status(403).json({
        success: false,
        message: "Only Owner Can Unshare"
      });
    }

    await deviceRef.child("sharedWith/" + targetUid).remove();

    res.json({
      success: true,
      message: "Device Unshared Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

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


client.on("message", async (topic, message) => {

  try {

    const payload = JSON.parse(message.toString());
    const parts = topic.split("/");
    const deviceId = parts[1];

    const deviceRef = db.ref("devices/" + deviceId);
    const snapshot = await deviceRef.once("value");
    const device = snapshot.val();

    if (!device) return;

    if (device.secret && payload.secret) {

      if (device.secret !== payload.secret) {
        console.log("🚫 Secret Invalid:", deviceId);
        return;
      }
    }

  await deviceRef.update({
  lastSeen: Date.now(),
  status: "ONLINE",
  data: payload,
  capabilities: payload.capabilities || null  // ✅ Save Capability
});

  } catch (err) {

    console.log("MQTT Error:", err.message);

  }

});


/* ====================================================
   COMMAND LISTENER
==================================================== */

db.ref("devices").on("child_changed", async (snapshot) => {

  try {

    const deviceId = snapshot.key;
    const data = snapshot.val();

    if (data && data.command) {

      const topic = `device/${deviceId}/command`;

      client.publish(topic, JSON.stringify({
        cmd: data.command
      }), { qos: 1 });

      await db.ref("devices/" + deviceId + "/command").set(null);
    }

  } catch (err) {

    console.log("Command Error:", err.message);

  }

});


/* ====================================================
   OFFLINE DETECTION
==================================================== */

setInterval(async () => {

  try {

    const snapshot = await db.ref("devices").once("value");
    const devices = snapshot.val();

    if (!devices) return;

    for (const deviceId of Object.keys(devices)) {

      const device = devices[deviceId];

      if (device.lastSeen) {

        const diff = Date.now() - device.lastSeen;

        if (diff > 60000 && device.status !== "OFFLINE") {

          await db.ref("devices/" + deviceId).update({
            status: "OFFLINE"
          });

        }
      }
    }

  } catch (err) {

    console.log("Offline Check Error:", err.message);

  }

}, 10000);


/* ====================================================
   OTA SYSTEM
==================================================== */

app.get("/latest-firmware", async (req, res) => {

  try {

    const snapshot = await db.ref("firmware").once("value");
    const firmware = snapshot.val();

    if (!firmware) {

      return res.json({
        version: "1.0.0",
        fileUrl: "",
        forceUpdate: false
      });
    }

    res.json(firmware);

  } catch (err) {

    res.status(500).json({ error: err.message });
  }

});


app.post("/update-firmware", isAdmin, async (req, res) => {

  try {

    const { version, fileUrl, forceUpdate } = req.body;

    await db.ref("firmware").set({
      version,
      fileUrl,
      forceUpdate: forceUpdate || false,
      updatedAt: Date.now()
    });

    res.json({
      success: true,
      message: "Firmware Updated Successfully"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

/* ====================================================
   DASHBOARD API (ADMIN ONLY)
==================================================== */

app.get("/dashboard/stats", isAdmin, async (req, res) => {

  try {

    const deviceSnap = await db.ref("devices").once("value");
    const devices = deviceSnap.val() || {};

    let totalDevices = Object.keys(devices).length;
    let onlineDevices = 0;
    let offlineDevices = 0;

    Object.values(devices).forEach(device => {

      if (device.status === "ONLINE") onlineDevices++;
      if (device.status === "OFFLINE") offlineDevices++;

    });

    const userSnap = await db.ref("users").once("value");
    const users = userSnap.val() || {};
    const totalUsers = Object.keys(users).length;

    res.json({
      success: true,
      data: {
        totalDevices,
        onlineDevices,
        offlineDevices,
        totalUsers
      }
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});


/* ====================================================
   DASHBOARD DEVICE LIST (ADMIN ONLY)
==================================================== */

app.get("/dashboard/devices", isAdmin, async (req, res) => {

  try {

    const snapshot = await db.ref("devices").once("value");
    const devices = snapshot.val() || {};

    res.json({
      success: true,
      devices
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});


/* ====================================================
   DASHBOARD USER LIST (ADMIN ONLY)
==================================================== */

app.get("/dashboard/users", isAdmin, async (req, res) => {

  try {

    const snapshot = await db.ref("users").once("value");
    const users = snapshot.val() || {};

    res.json({
      success: true,
      users
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
