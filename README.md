# 📋 TaskNest — Production Setup Guide

Your todo app is now production-ready with real auth, a cloud database, email alerts, and free hosting.
Follow the steps below — the whole process takes about 20 minutes.

---

## Stack (100% Free)

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| **Firebase** (Google) | Auth + Database | Spark plan: unlimited auth, 1 GB storage, 50k reads/day |
| **EmailJS** | Task-expiry emails | 200 emails/month |
| **Vercel** | Hosting + CDN | Unlimited personal projects, custom domain support |

---

## Step 1 — Firebase Setup

### 1.1  Create a project
1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it `tasknest` → disable Google Analytics (optional) → **Create**

### 1.2  Enable Authentication
1. In the left sidebar: **Build → Authentication → Get Started**
2. Click **Email/Password** → toggle **Enable** → **Save**

### 1.3  Enable Firestore Database
1. **Build → Firestore Database → Create Database**
2. Choose **Start in production mode** → pick a region close to you → **Enable**
3. Go to **Rules** tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /todos/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

4. Click **Publish**

### 1.4  Get your config keys
1. Click the ⚙️ gear icon → **Project Settings → General**
2. Scroll to **Your Apps** → click **</>** (Web) → name it `tasknest-web` → **Register**
3. Copy the `firebaseConfig` object values into **`src/firebase.js`**

---

## Step 2 — EmailJS Setup

### 2.1  Create account
1. Go to [https://www.emailjs.com](https://www.emailjs.com) → **Sign Up Free**

### 2.2  Add an Email Service
1. **Email Services → Add New Service**
2. Choose **Gmail** → click **Connect Account** (sign in with your Gmail)
3. Note your **Service ID** (e.g. `service_abc123`)

### 2.3  Create an Email Template
1. **Email Templates → Create New Template**
2. Set **Subject**: `Task Expired: {{task_name}}`
3. Set **Body**:
```
Hi {{to_name}},

Your TaskNest task "{{task_name}}" has expired without completion.

Log in to update or reschedule it.

— The TaskNest Team
```
4. In **To Email** field: type `{{to_email}}`
5. **Save** → note your **Template ID** (e.g. `template_xyz789`)

### 2.4  Get your Public Key
1. Go to **Account → General → API Keys**
2. Copy your **Public Key** (e.g. `AbCdEfGhIjKlMnOp`)

### 2.5  Update the config
Paste the three values into **`src/emailService.js`**:
```js
const SERVICE_ID  = "service_abc123";
const TEMPLATE_ID = "template_xyz789";
const PUBLIC_KEY  = "AbCdEfGhIjKlMnOp";
```

---

## Step 3 — Local Test

```bash
# Install dependencies
npm install

# Run locally
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) — create an account and make a task. ✅

---

## Step 4 — Deploy to Vercel (Free Hosting)

### 4.1  Push to GitHub
```bash
git init
git add .
git commit -m "Initial TaskNest commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/tasknest.git
git push -u origin main
```

### 4.2  Deploy on Vercel
1. Go to [https://vercel.com](https://vercel.com) → **Sign Up with GitHub**
2. Click **Add New → Project**
3. Import your `tasknest` repo
4. Framework: **Vite** (auto-detected)
5. Click **Deploy** — done! 🎉

Vercel gives you a free URL like `tasknest-xyz.vercel.app`.

### 4.3  (Optional) Custom Domain
In Vercel dashboard → **Domains** → add any domain you own for free SSL.

---

## Step 5 — Firebase Authorised Domains

After deploying, tell Firebase your live URL is allowed:
1. Firebase Console → **Authentication → Settings → Authorised Domains**
2. Click **Add Domain** → paste your Vercel URL (e.g. `tasknest-xyz.vercel.app`)

---

## Project Structure

```
tasknest/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx          ← React entry point
    ├── firebase.js       ← 🔑 YOUR FIREBASE CONFIG HERE
    ├── emailService.js   ← 🔑 YOUR EMAILJS CONFIG HERE
    └── App.jsx           ← Full app (UI + logic)
```

---

## Features

- ✅ Multi-user auth (sign up / sign in / forgot password via real email)
- ✅ Real-time cloud database (Firestore) — data syncs across devices
- ✅ Task expiry emails — automatically sent when a task passes its End Time
- ✅ 7-day history with day-by-day accordion view
- ✅ Tasks auto-cleaned after 7 days
- ✅ Fully responsive layout with animated sidebar

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Firebase: Error (auth/…)" | Double-check your `firebase.js` config keys |
| Emails not sending | Verify all 3 EmailJS values in `emailService.js`; check EmailJS dashboard logs |
| Firestore permission denied | Check your Firestore Rules are published correctly (Step 1.3) |
| Login works locally but not on Vercel | Add your Vercel domain to Firebase Authorised Domains (Step 5) |
