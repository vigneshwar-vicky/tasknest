import { useState, useEffect, useRef } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { sendTaskExpiredEmail } from "./emailService";

// ─── Constants ────────────────────────────────────────────────────────────────
const APP_VERSION = "1.3.0";
const GEMINI_KEY = import.meta.env.VITE_GEMINI;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
const FEEDBACK_EMAIL = "tasknest.application@gmail.com";

const PRIORITY_DEFAULTS = { high: 60, medium: 240, low: 480 };
const PRIORITY_COLOR    = { high: "#e74c3c", medium: "#f5a623", low: "#27ae60" };
const PRIORITY_LABEL    = { high: "High", medium: "Medium", low: "Low" };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const genId = () =>
  `TODO-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

const timeToMins = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const checkConflict = (newTask, existingTodos, editingId = null) => {
  if (!newTask.startTime || !newTask.endTime) return null;
  const ns = timeToMins(newTask.startTime);
  const ne = timeToMins(newTask.endTime);
  if (ne <= ns) return null;
  const actives = existingTodos.filter(
    (t) =>
      t.id !== editingId &&
      (t.status === "new" || t.status === "inprogress") &&
      t.startTime && t.endTime &&
      t.createdDate === today()
  );
  for (const t of actives) {
    const ts = timeToMins(t.startTime);
    const te = timeToMins(t.endTime);
    if (ns < te && ne > ts) return t;
  }
  return null;
};

const last7 = () => {
  const a = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    a.push(d.toISOString().slice(0, 10));
  }
  return a;
};

// ─── TimePicker (fixed) ───────────────────────────────────────────────────────
function TimePicker({ value, onChange, label }) {
  const toDisplay = (v) => {
    if (!v) return { h: 12, m: 0, am: "AM" };
    const [hh, mm] = v.split(":").map(Number);
    return {
      h:  hh === 0 ? 12 : hh > 12 ? hh - 12 : hh,
      m:  mm,
      am: hh < 12 ? "AM" : "PM",
    };
  };

  const init = toDisplay(value);
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(init.h);
  const [m, setM] = useState(init.m);
  const [am, setAm] = useState(init.am);
  const ref = useRef();

  // sync when value prop changes (fixes edit bug)
  useEffect(() => {
    const d = toDisplay(value);
    setH(d.h); setM(d.m); setAm(d.am);
  }, [value]);

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const commit = () => {
    let hour = h % 12;
    if (am === "PM") hour += 12;
    onChange(`${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    setOpen(false);
  };

  const display = value ? (() => {
    const [hh, mm] = value.split(":");
    const ih = parseInt(hh);
    const disp = ih === 0 ? 12 : ih > 12 ? ih - 12 : ih;
    return `${disp}:${String(mm).padStart(2,"0")} ${ih < 12 ? "AM" : "PM"}`;
  })() : "";

  return (
    <div className="tp-wrap" ref={ref}>
      <div className="tp-field" onClick={() => setOpen((o) => !o)}>
        <span className="tp-clock">🕐</span>
        <input readOnly value={display} placeholder={label} className="tp-input" onChange={() => {}} />
      </div>
      {open && (
        <div className="tp-popup">
          <div className="tp-title">{label}</div>
          <div className="tp-row">
            <button type="button" onClick={() => setH((h) => (h > 1 ? h - 1 : 12))}>‹</button>
            <input className="tp-num" value={h}
              onChange={(e) => setH(Math.max(1, Math.min(12, parseInt(e.target.value) || 1)))} />
            <button type="button" onClick={() => setH((h) => (h < 12 ? h + 1 : 1))}>›</button>
            <span className="tp-colon">:</span>
            <button type="button" onClick={() => setM((m) => (m > 0 ? m - 1 : 59))}>‹</button>
            <input className="tp-num" value={String(m).padStart(2, "0")}
              onChange={(e) => setM(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))} />
            <button type="button" onClick={() => setM((m) => (m < 59 ? m + 1 : 0))}>›</button>
          </div>
          <div className="tp-ampm">
            <button type="button" className={am === "AM" ? "active" : ""} onClick={() => setAm("AM")}>AM</button>
            <button type="button" className={am === "PM" ? "active" : ""} onClick={() => setAm("PM")}>PM</button>
          </div>
          <button type="button" className="tp-ok" onClick={commit}>Set Time</button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [authUser, setAuthUser]         = useState(null);
  const [userProfile, setUserProfile]   = useState(null);
  const [todos, setTodos]               = useState([]);
  const [page, setPage]                 = useState("loading");
  const [sidebar, setSidebar]           = useState(false);
  const [toast, setToast]               = useState(null);
  const [editTodo, setEditTodo]         = useState(null);

  // Account menu
  const [acctMenu, setAcctMenu]         = useState(false);
  const [acctModal, setAcctModal]       = useState(null); // "edit"|"theme"|"about"|"feedback"
  const acctRef                         = useRef();

  // Theme
  const [darkMode, setDarkMode]         = useState(() => localStorage.getItem("tn_theme") === "dark");

  // Edit account form
  const [editAcctForm, setEditAcctForm] = useState({ firstName: "", lastName: "" });

  // Feedback
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);

  // Chat bot
  const [chatOpen, setChatOpen]     = useState(false);
  const [chatMsgs, setChatMsgs]     = useState([{ role: "ai", text: "Hi! I'm your TaskNest AI assistant 🤖\nI can help you:\n• View and filter your tasks\n• Create new tasks\n• Summarize your day\n\nTry asking: Create a task for code review, high priority, 9am to 10am" }]);
  const [chatInput, setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef                  = useRef();
  const chatInputRef                = useRef();
  const lastChatTime                = useRef(0);

  useEffect(() => {
    localStorage.setItem("tn_theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  // Close account menu on outside click
  useEffect(() => {
    const fn = (e) => { if (acctRef.current && !acctRef.current.contains(e.target)) setAcctMenu(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4500);
  };

  // ── Auth state ────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setAuthUser(user);
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) setUserProfile(snap.data());
        setPage("todo");
      } else {
        setAuthUser(null); setUserProfile(null); setTodos([]);
        setPage("signin");
      }
    });
    return unsub;
  }, []);

  // ── Real-time todos ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!authUser) return;
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const unsub = onSnapshot(doc(db, "todos", authUser.uid), (snap) => {
      if (snap.exists()) {
        setTodos((snap.data().items || []).filter((t) => new Date(t.createdDate) >= cutoff));
      } else setTodos([]);
    });
    return unsub;
  }, [authUser]);

  // ── Expiry checker ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authUser || !userProfile) return;
    const check = async () => {
      const snap = await getDoc(doc(db, "todos", authUser.uid));
      if (!snap.exists()) return;
      const items = snap.data().items || [];
      const now = new Date();
      let changed = false;
      const updated = items.map((t) => {
        if ((t.status === "new" || t.status === "inprogress") && t.endTime) {
          const end = new Date(`${today()}T${t.endTime}`);
          if (now > end) {
            changed = true;
            sendTaskExpiredEmail(authUser.email, userProfile.firstName, t.activity);
            return { ...t, status: "expired", comments: (t.comments || "") + (t.comments ? "\n" : "") + "Task not completed on time" };
          }
        }
        return t;
      });
      if (changed) await setDoc(doc(db, "todos", authUser.uid), { items: updated });
    };
    check();
    const iv = setInterval(check, 60000);
    return () => clearInterval(iv);
  }, [authUser, userProfile]);

  // ── Auth forms ────────────────────────────────────────────────────────────
  const [signupForm, setSignupForm] = useState({ firstName: "", lastName: "", email: "", password: "" });
  const [signinForm, setSigninForm] = useState({ email: "", password: "" });
  const [forgotEmail, setForgotEmail] = useState("");

  const handleSignup = async (e) => {
    e.preventDefault();
    try {
      const cred = await createUserWithEmailAndPassword(auth, signupForm.email, signupForm.password);
      await updateProfile(cred.user, { displayName: `${signupForm.firstName} ${signupForm.lastName}` });
      const profile = { firstName: signupForm.firstName, lastName: signupForm.lastName, email: signupForm.email.toLowerCase() };
      await setDoc(doc(db, "users", cred.user.uid), profile);
      setUserProfile(profile);
      showToast(`Welcome, ${signupForm.firstName}! 🎉`);
    } catch (err) {
      showToast(
        err.code === "auth/email-already-in-use" ? "Email already registered" :
        err.code === "auth/weak-password" ? "Password must be at least 6 characters" :
        "Sign up failed – check your details", "error"
      );
    }
  };

  const handleSignin = async (e) => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, signinForm.email, signinForm.password); }
    catch { showToast("Invalid email or password", "error"); }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    try { await sendPasswordResetEmail(auth, forgotEmail); showToast("Reset link sent! Check your inbox 📬"); setPage("signin"); }
    catch { showToast("Email not found", "error"); }
  };

  const handleLogout = () => signOut(auth);

  // ── AI Chatbot ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (chatOpen && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMsgs, chatOpen]);

  const handleChatSend = async (quickMsg) => {
    const msg = (quickMsg !== undefined ? quickMsg : chatInput).trim();
    if (!msg || chatLoading) return;

    // Rate limit: 4 seconds between requests (free tier = 15 RPM)
    const now = Date.now();
    const elapsed = now - lastChatTime.current;
    if (elapsed < 4000) {
      const wait = Math.ceil((4000 - elapsed) / 1000);
      setChatMsgs((prev) => [...prev, {
        role: "ai",
        text: "⏳ Please wait " + wait + " second" + (wait > 1 ? "s" : "") + " before sending another message.",
      }]);
      return;
    }
    lastChatTime.current = now;

    setChatInput("");
    setChatMsgs((prev) => [...prev, { role: "user", text: msg }]);
    setChatLoading(true);

    try {
      const active   = todos.filter((t) => t.status === "new" || t.status === "inprogress");
      const done     = todos.filter((t) => t.status === "completed" && t.createdDate === today());
      const expired  = todos.filter((t) => t.status === "expired");

      const taskList = todos.length === 0
        ? "No tasks yet."
        : todos.map((t) =>
            "• [" + t.status.toUpperCase() + "][" + (t.priority || "medium").toUpperCase() + "] "
            + t.activity + " | Est:" + t.estimateTime + "min"
            + " Start:" + (t.startTime || "-") + " End:" + (t.endTime || "-")
          ).join("\n");

      const taskJsonExample = JSON.stringify({
        action: "create_task", activity: "Task name",
        priority: "high", estimateTime: "60",
        startTime: "09:00", endTime: "10:00", comments: ""
      });

      const prompt =
        "You are TaskNest AI, a smart task management assistant. "
        + "User: " + (userProfile?.firstName || "User") + ". Today: " + today() + ".\n\n"
        + "TASKS:\n" + taskList + "\n\n"
        + "STATS: Active=" + active.length + " Done=" + done.length + " Expired=" + expired.length + "\n\n"
        + "RULES:\n"
        + "1. Answer task questions helpfully and intelligently.\n"
        + "2. To CREATE a task respond with ONLY this JSON (nothing else):\n"
        + taskJsonExample + "\n"
        + "3. Time: 9am=09:00 2pm=14:00 10pm=22:00. No time = empty string.\n"
        + "4. Priority defaults: high=60min medium=240min low=480min.\n"
        + "5. All other queries: max 80 words, friendly and concise.\n\n"
        + "User says: " + msg;

      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
        }),
      });

      const data = await res.json();

      if (data.error) {
        const msg429 = data.error.code === 429 || (data.error.message || "").includes("quota")
          ? "⏳ Rate limit reached. Please wait 30 seconds and try again. (Free tier: 15 requests/min)"
          : "⚠️ " + (data.error.message || "API error");
        setChatMsgs((prev) => [...prev, { role: "ai", text: msg429 }]);
        return;
      }

      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!reply) {
        setChatMsgs((prev) => [...prev, { role: "ai", text: "⚠️ No response. Please try again." }]);
        return;
      }

      // Detect task creation JSON
      const jm = reply.trim().match(/\{[\s\S]*?\}/);
      if (jm) {
        try {
          const p = JSON.parse(jm[0]);
          if (p.action === "create_task" && p.activity) {
            const conflict = checkConflict(p, todos);
            if (conflict) {
              setChatMsgs((prev) => [...prev, { role: "ai",
                text: "⚠️ Time conflict with \"" + conflict.activity + "\" ("
                  + conflict.startTime + "–" + conflict.endTime + "). Choose a different time!"
              }]);
            } else {
              const newTodo = {
                activity:     p.activity,
                priority:     p.priority     || "medium",
                status:       "new",
                estimateTime: p.estimateTime || String(PRIORITY_DEFAULTS[p.priority || "medium"]),
                startTime:    p.startTime    || "",
                endTime:      p.endTime      || "",
                actualTime:   "",
                comments:     p.comments     || "",
                id:           genId(),
                createdDate:  today(),
                createdAt:    new Date().toISOString(),
              };
              await saveTodos([...todos, newTodo]);
              setChatMsgs((prev) => [...prev, { role: "ai",
                text: "✅ Task created!\n📌 " + newTodo.activity
                  + "\n🎯 " + PRIORITY_LABEL[newTodo.priority]
                  + " | ⏱ " + newTodo.estimateTime + " mins"
                  + (newTodo.startTime ? " | 🕐 " + newTodo.startTime + "–" + newTodo.endTime : "")
                  + "\n\nCheck your Todo List! ✔️"
              }]);
            }
            return;
          }
        } catch (_) {}
      }

      setChatMsgs((prev) => [...prev, { role: "ai", text: reply }]);

    } catch (err) {
      setChatMsgs((prev) => [...prev, { role: "ai", text: "⚠️ Network error. Please check your connection." }]);
    } finally {
      setChatLoading(false);
    }
  };


  // ── Edit Account ──────────────────────────────────────────────────────────
  const openEditAcct = () => {
    setEditAcctForm({ firstName: userProfile?.firstName || "", lastName: userProfile?.lastName || "" });
    setAcctModal("edit");
    setAcctMenu(false);
  };

  const handleEditAcct = async (e) => {
    e.preventDefault();
    if (!editAcctForm.firstName.trim()) return showToast("First name is required", "error");
    try {
      await updateProfile(authUser, { displayName: `${editAcctForm.firstName} ${editAcctForm.lastName}` });
      const updated = { ...userProfile, firstName: editAcctForm.firstName, lastName: editAcctForm.lastName };
      await setDoc(doc(db, "users", authUser.uid), updated);
      setUserProfile(updated);
      showToast("Account updated successfully! ✅");
      setAcctModal(null);
    } catch { showToast("Failed to update account. Try again.", "error"); }
  };

  // ── Feedback ──────────────────────────────────────────────────────────────
  const handleFeedback = async (e) => {
    e.preventDefault();
    if (!feedbackText.trim()) return showToast("Please enter your feedback", "error");
    setFeedbackSending(true);
    try {
      const { default: emailjs } = await import("@emailjs/browser");
      await emailjs.send(
        "service_1pi4kca",
        "template_3e282mb",
        {
          to_name:   "TaskNest Team",
          to_email:  FEEDBACK_EMAIL,
          task_name: `Feedback from ${userProfile?.firstName} ${userProfile?.lastName}`,
          message:   feedbackText,
        },
        "8GpnlxYEEPYtypCL0"
      );
      showToast("Thank you for your feedback! 🙏 We'll review it soon.");
      setFeedbackText("");
      setAcctModal(null);
    } catch {
      showToast("Failed to send feedback. Please try again later.", "error");
    } finally {
      setFeedbackSending(false);
    }
  };

  // ── Todo helpers ──────────────────────────────────────────────────────────
  const BLANK_FORM = {
    activity: "", status: "new", priority: "medium",
    estimateTime: String(PRIORITY_DEFAULTS.medium),
    startTime: "", endTime: "", actualTime: "", comments: "",
  };
  const [todoForm, setTodoForm] = useState(BLANK_FORM);
  const [formOpen, setFormOpen] = useState(false);

  const saveTodos = (items) => setDoc(doc(db, "todos", authUser.uid), { items });

  const handleTodoSubmit = async (e) => {
    e.preventDefault();
    if (!todoForm.activity || !todoForm.estimateTime)
      return showToast("Activity & Estimate Time are required", "error");

    // Conflict check
    const conflict = checkConflict(todoForm, todos, editTodo?.id);
    if (conflict) {
      showToast(
        `⚠️ Time conflict with "${conflict.activity}" (${conflict.startTime} – ${conflict.endTime}). Please choose a different time slot.`,
        "error"
      );
      return;
    }

    let newItems;
    if (editTodo) {
      newItems = todos.map((t) => t.id === editTodo.id ? { ...t, ...todoForm } : t);
      showToast("Task updated ✏️");
    } else {
      newItems = [...todos, { ...todoForm, id: genId(), createdDate: today(), createdAt: new Date().toISOString() }];
      showToast("Task created ✅");
    }
    await saveTodos(newItems);
    setTodoForm(BLANK_FORM); setFormOpen(false); setEditTodo(null);
  };

  const deleteTodo = async (id) => {
    await saveTodos(todos.filter((t) => t.id !== id));
    showToast("Task deleted");
  };

  const openEdit = (todo) => {
    setEditTodo(todo);
    setTodoForm({
      activity:     todo.activity,
      status:       todo.status,
      priority:     todo.priority || "medium",
      estimateTime: todo.estimateTime,
      startTime:    todo.startTime  || "",
      endTime:      todo.endTime    || "",
      actualTime:   todo.actualTime || "",
      comments:     todo.comments   || "",
    });
    setFormOpen(true);
  };

  const handlePriorityChange = (priority) => {
    setTodoForm((f) => ({
      ...f,
      priority,
      estimateTime: String(PRIORITY_DEFAULTS[priority]),
    }));
  };

  const STATUS_COLOR = { new: "#4a9eff", inprogress: "#f5a623", completed: "#27ae60", expired: "#e74c3c" };
  const STATUS_LABEL = { new: "New", inprogress: "In Progress", completed: "Completed", expired: "Expired" };

  // ── History (only days with tasks, bug fixed) ─────────────────────────────
  const [expanded, setExpanded] = useState({});
  const days = last7();
  const grouped = days.reduce((acc, d) => { acc[d] = todos.filter((t) => t.createdDate === d); return acc; }, {});
  const daysWithTasks = [...days].reverse().filter((d) => grouped[d]?.length > 0 || d === today());

  // ── Loading ───────────────────────────────────────────────────────────────
  if (page === "loading") return (
    <div className={`loading-screen ${darkMode ? "dark" : ""}`}>
      <div className="loading-logo">📋</div>
      <div className="loading-name">TaskNest</div>
      <div className="loading-dot-row"><span /><span /><span /></div>
    </div>
  );

  return (
    <div className={`app ${darkMode ? "dark" : ""}`}>
      <style>{CSS}</style>

      {/* Toast */}
      {toast && <div className={`toast ${toast.type || ""}`}>{toast.msg}</div>}

      {/* ── AUTH PAGES ── */}
      {(page === "signin" || page === "signup" || page === "forgot") && (
        <div className="auth-bg">
          <div className="auth-card">
            <div className="auth-logo">📋 TaskNest</div>
            <div className="auth-subtitle">Your cozy productivity corner</div>

            {page === "signin" && (<>
              <h2 className="auth-heading">Sign In</h2>
              <form onSubmit={handleSignin} className="auth-form">
                <label>Email Address</label>
                <input type="email" required value={signinForm.email} onChange={(e) => setSigninForm({ ...signinForm, email: e.target.value })} placeholder="you@example.com" />
                <label>Password</label>
                <input type="password" required value={signinForm.password} onChange={(e) => setSigninForm({ ...signinForm, password: e.target.value })} placeholder="••••••••" />
                <button type="submit" className="btn-primary">Sign In</button>
                <div className="auth-links">
                  <span onClick={() => setPage("forgot")} className="link">Forgot Password?</span>
                  <span onClick={() => setPage("signup")} className="link">Create Account</span>
                </div>
              </form>
            </>)}

            {page === "signup" && (<>
              <h2 className="auth-heading">Create Account</h2>
              <form onSubmit={handleSignup} className="auth-form">
                <div className="two-col">
                  <div><label>First Name</label><input required value={signupForm.firstName} onChange={(e) => setSignupForm({ ...signupForm, firstName: e.target.value })} placeholder="Jane" /></div>
                  <div><label>Last Name</label><input required value={signupForm.lastName} onChange={(e) => setSignupForm({ ...signupForm, lastName: e.target.value })} placeholder="Doe" /></div>
                </div>
                <label>Email Address</label>
                <input type="email" required value={signupForm.email} onChange={(e) => setSignupForm({ ...signupForm, email: e.target.value })} placeholder="you@example.com" />
                <label>Password</label>
                <input type="password" required minLength={6} value={signupForm.password} onChange={(e) => setSignupForm({ ...signupForm, password: e.target.value })} placeholder="Min 6 characters" />
                <button type="submit" className="btn-primary">Create Account</button>
                <div className="auth-links">
                  <span onClick={() => setPage("signin")} className="link">Already have an account? Sign In</span>
                </div>
              </form>
            </>)}

            {page === "forgot" && (<>
              <h2 className="auth-heading">Reset Password</h2>
              <form onSubmit={handleForgot} className="auth-form">
                <label>Email Address</label>
                <input type="email" required value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} placeholder="you@example.com" />
                <button type="submit" className="btn-primary">Send Reset Link 📬</button>
                <div className="auth-links">
                  <span onClick={() => setPage("signin")} className="link">← Back to Sign In</span>
                </div>
              </form>
            </>)}
          </div>
        </div>
      )}

      {/* ── APP PAGES ── */}
      {(page === "todo" || page === "history") && authUser && userProfile && (
        <div className="layout">

          {/* Sidebar */}
          <div className={`sidebar ${sidebar ? "expanded" : ""}`}
            onMouseEnter={() => setSidebar(true)}
            onMouseLeave={() => { setSidebar(false); }}>
            <div className="sb-logo">{sidebar ? "📋 TaskNest" : "📋"}</div>
            <nav className="sb-nav">
              <div className={`sb-item ${page === "todo" ? "active" : ""}`} onClick={() => setPage("todo")}>
                <span className="sb-icon">✅</span>{sidebar && <span className="sb-label">Todo List</span>}
              </div>
              <div className={`sb-item ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}>
                <span className="sb-icon">🕐</span>{sidebar && <span className="sb-label">History</span>}
              </div>
            </nav>

            {/* Account menu trigger */}
            <div className="sb-acct-wrap" ref={acctRef}>
              <div className="sb-user" onClick={() => setAcctMenu((o) => !o)} title="Account">
                <span className="sb-icon">👤</span>
                {sidebar && <span className="sb-label">{userProfile.firstName} ▾</span>}
              </div>

              {/* Mini popup menu */}
              {acctMenu && (
                <div className={`acct-popup ${sidebar ? "expanded" : ""}`}>
                  <div className="acct-popup-header">
                    <div className="acct-popup-name">{userProfile.firstName} {userProfile.lastName}</div>
                    <div className="acct-popup-email">{authUser.email}</div>
                  </div>
                  <div className="acct-popup-divider" />
                  <div className="acct-popup-item" onClick={openEditAcct}>
                    <span>✏️</span><span>Edit Account</span>
                  </div>
                  <div className="acct-popup-item" onClick={() => { setDarkMode((d) => !d); setAcctMenu(false); }}>
                    <span>{darkMode ? "☀️" : "🌙"}</span>
                    <span>{darkMode ? "Light Theme" : "Dark Theme"}</span>
                  </div>
                  <div className="acct-popup-item" onClick={() => { setAcctModal("about"); setAcctMenu(false); }}>
                    <span>ℹ️</span><span>About</span>
                  </div>
                  <div className="acct-popup-item" onClick={() => { setFeedbackText(""); setAcctModal("feedback"); setAcctMenu(false); }}>
                    <span>💬</span><span>Feedback</span>
                  </div>
                  <div className="acct-popup-divider" />
                  <div className="acct-popup-item acct-logout" onClick={handleLogout}>
                    <span>🚪</span><span>Logout</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Main */}
          <div className="main">
            <div className="main-inner">

              {/* ── TODO PAGE ── */}
              {page === "todo" && (<>
                <div className="page-header">
                  <div>
                    <h1 className="page-title">My Todo List</h1>
                    <div className="page-sub">{fmtDate(new Date())}</div>
                  </div>
                  <button className="btn-primary" onClick={() => { setEditTodo(null); setTodoForm(BLANK_FORM); setFormOpen(true); }}>
                    + New Task
                  </button>
                </div>

                {/* Form Modal */}
                {formOpen && (
                  <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && setFormOpen(false)}>
                    <div className="modal">
                      <h2 className="modal-title">{editTodo ? "Edit Task" : "Create Task"}</h2>
                      <form onSubmit={handleTodoSubmit} className="todo-form">
                        <div className="two-col">
                          <div className="full">
                            <label>Activity Name *</label>
                            <input required value={todoForm.activity}
                              onChange={(e) => setTodoForm({ ...todoForm, activity: e.target.value })}
                              placeholder="What needs to be done?" />
                          </div>
                        </div>

                        {/* Priority */}
                        <label>Priority</label>
                        <div className="priority-row">
                          {["high", "medium", "low"].map((p) => (
                            <button key={p} type="button"
                              className={`priority-btn ${todoForm.priority === p ? "active" : ""}`}
                              style={{ "--pc": PRIORITY_COLOR[p] }}
                              onClick={() => handlePriorityChange(p)}>
                              {PRIORITY_LABEL[p]}
                            </button>
                          ))}
                        </div>

                        <div className="two-col">
                          <div>
                            <label>Status</label>
                            <select value={todoForm.status} onChange={(e) => setTodoForm({ ...todoForm, status: e.target.value })}>
                              <option value="new">New</option>
                              <option value="inprogress">In Progress</option>
                              <option value="completed">Completed</option>
                              <option value="expired">Expired</option>
                            </select>
                          </div>
                          <div>
                            <label>Estimate Time (mins) *</label>
                            <input type="number" required min="1" value={todoForm.estimateTime}
                              onChange={(e) => setTodoForm({ ...todoForm, estimateTime: e.target.value })}
                              placeholder="60" />
                          </div>
                        </div>

                        <div className="two-col">
                          <div>
                            <label>Start Time</label>
                            <TimePicker value={todoForm.startTime} onChange={(v) => setTodoForm({ ...todoForm, startTime: v })} label="Start Time" />
                          </div>
                          <div>
                            <label>End Time</label>
                            <TimePicker value={todoForm.endTime} onChange={(v) => setTodoForm({ ...todoForm, endTime: v })} label="End Time" />
                          </div>
                        </div>

                        <div className="two-col">
                          <div>
                            <label>Actual Time Taken (mins)</label>
                            <input type="number" min="0" value={todoForm.actualTime}
                              onChange={(e) => setTodoForm({ ...todoForm, actualTime: e.target.value })}
                              placeholder="0" />
                          </div>
                        </div>

                        <div>
                          <label>Comments</label>
                          <textarea value={todoForm.comments}
                            onChange={(e) => setTodoForm({ ...todoForm, comments: e.target.value })}
                            rows={3} placeholder="Any notes..." />
                        </div>

                        <div className="form-actions">
                          <button type="button" className="btn-cancel" onClick={() => { setFormOpen(false); setEditTodo(null); }}>Cancel</button>
                          <button type="submit" className="btn-primary">{editTodo ? "Update Task ✓" : "Create Task ✓"}</button>
                        </div>
                      </form>
                    </div>
                  </div>
                )}

                {/* Todo Cards */}
                <div className="todos-grid">
                  {todos.length === 0 && (
                    <div className="empty-state">
                      <div className="empty-icon">📝</div>
                      <div>No tasks yet. Create your first task!</div>
                    </div>
                  )}
                  {todos.map((todo) => (
                    <div key={todo.id} className={`todo-card status-${todo.status}`}>
                      <div className="todo-card-header">
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="todo-badge" style={{ background: STATUS_COLOR[todo.status] }}>
                            {STATUS_LABEL[todo.status]}
                          </span>
                          {todo.priority && (
                            <span className="todo-badge" style={{ background: PRIORITY_COLOR[todo.priority] }}>
                              {PRIORITY_LABEL[todo.priority]}
                            </span>
                          )}
                        </div>
                        <div className="todo-actions">
                          <button className="icon-btn" onClick={() => openEdit(todo)} title="Edit">✏️</button>
                          <button className="icon-btn" onClick={() => deleteTodo(todo.id)} title="Delete">🗑️</button>
                        </div>
                      </div>
                      <div className="todo-activity">{todo.activity}</div>
                      <div className="todo-id">ID: {todo.id}</div>
                      <div className="todo-meta">
                        {todo.estimateTime && <span>⏱ Est: {todo.estimateTime} mins</span>}
                        {todo.startTime && <span>▶ Start: {todo.startTime}</span>}
                        {todo.endTime && <span>⏹ End: {todo.endTime}</span>}
                        {todo.actualTime && <span>✅ Actual: {todo.actualTime} mins</span>}
                      </div>
                      {todo.comments && <div className="todo-comments">💬 {todo.comments}</div>}
                      <div className="todo-date">Created: {fmtDate(todo.createdDate)}</div>
                    </div>
                  ))}
                </div>
              </>)}

              {/* ── HISTORY PAGE ── */}
              {page === "history" && (<>
                <div className="page-header">
                  <div>
                    <h1 className="page-title">History</h1>
                    <div className="page-sub">Last 7 days · Read only</div>
                  </div>
                </div>
                <div className="history-list">
                  {daysWithTasks.length === 0 && (
                    <div className="empty-state">
                      <div className="empty-icon">📂</div>
                      <div>No task history yet. Start creating tasks!</div>
                    </div>
                  )}
                  {daysWithTasks.map((d) => {
                    const items = grouped[d] || [];
                    const isOpen = expanded[d];
                    return (
                      <div key={d} className="history-group">
                        <div className="history-date-row" onClick={() => setExpanded((ex) => ({ ...ex, [d]: !ex[d] }))}>
                          <span className="history-expand">{isOpen ? "▼" : "▶"}</span>
                          <span className="history-date-label">{fmtDate(d)}</span>
                          <span className="history-count">{items.length} task{items.length !== 1 ? "s" : ""}</span>
                          {d === today() && <span className="today-badge">Today</span>}
                        </div>
                        {isOpen && (
                          <div className="history-items">
                            {items.length === 0 && <div className="history-empty">No tasks on this day</div>}
                            {items.map((todo) => (
                              <div key={todo.id} className="history-card">
                                <div className="hc-top">
                                  <span className="todo-badge" style={{ background: STATUS_COLOR[todo.status] }}>{STATUS_LABEL[todo.status]}</span>
                                  {todo.priority && <span className="todo-badge" style={{ background: PRIORITY_COLOR[todo.priority] }}>{PRIORITY_LABEL[todo.priority]}</span>}
                                  <span className="hc-id">{todo.id}</span>
                                </div>
                                <div className="hc-activity">{todo.activity}</div>
                                <div className="todo-meta">
                                  {todo.estimateTime && <span>⏱ Est: {todo.estimateTime} mins</span>}
                                  {todo.startTime && <span>▶ {todo.startTime}</span>}
                                  {todo.endTime && <span>⏹ {todo.endTime}</span>}
                                  {todo.actualTime && <span>✅ {todo.actualTime} mins</span>}
                                </div>
                                {todo.comments && <div className="todo-comments">💬 {todo.comments}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>)}
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT ACCOUNT MODAL ── */}
      {acctModal === "edit" && (
        <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && setAcctModal(null)}>
          <div className="modal">
            <h2 className="modal-title">✏️ Edit Account</h2>
            <div className="profile-info">
              <div className="profile-row"><span className="profile-label">Email</span><span className="profile-value">{authUser?.email}</span></div>
            </div>
            <form onSubmit={handleEditAcct} className="todo-form">
              <div className="two-col">
                <div>
                  <label>First Name *</label>
                  <input required value={editAcctForm.firstName}
                    onChange={(e) => setEditAcctForm({ ...editAcctForm, firstName: e.target.value })}
                    placeholder="Jane" />
                </div>
                <div>
                  <label>Last Name</label>
                  <input value={editAcctForm.lastName}
                    onChange={(e) => setEditAcctForm({ ...editAcctForm, lastName: e.target.value })}
                    placeholder="Doe" />
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn-cancel" onClick={() => setAcctModal(null)}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ marginTop: 0 }}>Save Changes ✓</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── ABOUT MODAL ── */}
      {acctModal === "about" && (
        <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && setAcctModal(null)}>
          <div className="modal" style={{ maxWidth: 400, textAlign: "center" }}>
            <div style={{ fontSize: "3rem", marginBottom: 12 }}>📋</div>
            <h2 className="modal-title" style={{ textAlign: "center", borderBottom: "none" }}>TaskNest</h2>
            <div className="about-version">Version {APP_VERSION}</div>
            <div className="about-desc">Your cozy productivity corner.<br />Built with React, Firebase & ❤️</div>
            <div className="about-meta">
              <span>🔥 Firebase Auth & Firestore</span>
              <span>⚡ Vite + React 18</span>
              <span>📧 EmailJS Notifications</span>
              <span>🚀 Hosted on Vercel</span>
            </div>
            <button className="btn-primary" style={{ marginTop: 20 }} onClick={() => setAcctModal(null)}>Close</button>
          </div>
        </div>
      )}

      {/* ── FEEDBACK MODAL ── */}
      {acctModal === "feedback" && (
        <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && setAcctModal(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h2 className="modal-title">💬 Feedback</h2>
            <p className="feedback-subtitle">Happy to hear any feedback for improvement or anything you'd like to share!</p>
            <form onSubmit={handleFeedback} className="todo-form">
              <label>Your Feedback *</label>
              <textarea required rows={5} value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Share your thoughts, suggestions, or report any issues..." />
              <div className="form-actions">
                <button type="button" className="btn-cancel" onClick={() => setAcctModal(null)}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ marginTop: 0 }} disabled={feedbackSending}>
                  {feedbackSending ? "Sending..." : "Send Feedback 🚀"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── AI CHATBOT FLOATING BUBBLE ── */}
      {(page === "todo" || page === "history") && authUser && (
        <>
          {/* Bubble */}
          <button className={`chat-bubble ${chatOpen ? "open" : ""}`} onClick={() => { setChatOpen((o) => !o); setTimeout(() => chatInputRef.current?.focus(), 100); }} title="AI Assistant">
            {chatOpen ? "✕" : "🤖"}
          </button>

          {/* Chat Panel */}
          {chatOpen && (
            <div className="chat-panel">
              <div className="chat-header">
                <div className="chat-header-info">
                  <span className="chat-avatar">🤖</span>
                  <div>
                    <div className="chat-title">TaskNest AI</div>
                    <div className="chat-subtitle">Powered by Gemini</div>
                  </div>
                </div>
                <button className="chat-close" onClick={() => setChatOpen(false)}>✕</button>
              </div>

              <div className="chat-messages">
                {chatMsgs.map((msg, i) => (
                  <div key={i} className={`chat-msg ${msg.role}`}>
                    {msg.role === "ai" && <span className="chat-msg-avatar">🤖</span>}
                    <div className="chat-msg-bubble">
                      {msg.text.split("\n").map((line, j) => (
                        <span key={j}>{line}{j < msg.text.split("\n").length - 1 && <br />}</span>
                      ))}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-msg ai">
                    <span className="chat-msg-avatar">🤖</span>
                    <div className="chat-msg-bubble chat-typing">
                      <span /><span /><span />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="chat-suggestions">
                {["What are my tasks today?", "Show high priority tasks", "Summarize my day", "Create a task for me"].map((s) => (
                  <button key={s} className="chat-suggestion" onClick={() => handleChatSend(s)}>
                    {s}
                  </button>
                ))}
              </div>

              <div className="chat-input-row">
                <input
                  ref={chatInputRef}
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleChatSend(undefined)}
                  placeholder="Ask me anything or create a task..."
                  disabled={chatLoading}
                />
                <button className="chat-send" onClick={() => handleChatSend(undefined)} disabled={chatLoading || !chatInput.trim()}>
                  ➤
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Lato:wght@400;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --wood:        #8B6340;
  --cream:       #F5EDD8;
  --paper:       #FDFAF2;
  --ink:         #2C1810;
  --ink2:        #5C4033;
  --accent:      #C0392B;
  --accent2:     #E67E22;
  --green:       #27AE60;
  --sidebar-w:   64px;
  --sidebar-exp: 220px;
  --bg-card:     rgba(253,250,242,0.95);
  --bg-main:     transparent;
  --text-main:   #2C1810;
}

.dark {
  --paper:    #1e1e2e;
  --bg-card:  rgba(40,40,60,0.97);
  --ink:      #e8e0d0;
  --ink2:     #a09080;
  --cream:    #e8e0d0;
  --bg-main:  rgba(0,0,0,0.3);
  --text-main:#e8e0d0;
}

body { font-family: 'Lato', sans-serif; }

/* Loading */
.loading-screen { min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--ink); color:var(--cream); gap:10px; }
.loading-logo { font-size:3rem; animation:pulse 1.2s ease infinite; }
.loading-name { font-family:'Caveat',cursive; font-size:2rem; font-weight:700; }
.loading-dot-row { display:flex; gap:8px; margin-top:8px; }
.loading-dot-row span { width:8px; height:8px; border-radius:50%; background:var(--accent2); animation:bounce 1.2s ease infinite; }
.loading-dot-row span:nth-child(2){animation-delay:.2s} .loading-dot-row span:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}

/* App background */
.app { min-height:100vh; background: linear-gradient(rgba(139,99,64,0.55),rgba(139,99,64,0.65)), url('https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?w=1600&q=80') center/cover fixed; }
.app.dark { background: linear-gradient(rgba(10,10,20,0.85),rgba(10,10,30,0.92)), url('https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?w=1600&q=80') center/cover fixed; }

/* Auth */
.auth-bg { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
.auth-card { background:rgba(253,250,242,0.97); border-radius:20px; padding:40px; width:100%; max-width:460px; box-shadow:0 20px 60px rgba(44,24,16,0.4); border-top:4px solid var(--accent); }
.dark .auth-card { background:rgba(30,30,46,0.98); }
.auth-logo { font-family:'Caveat',cursive; font-size:2.2rem; font-weight:700; color:var(--ink); text-align:center; margin-bottom:4px; }
.auth-subtitle { text-align:center; color:var(--ink2); font-size:0.88rem; margin-bottom:28px; font-style:italic; }
.auth-heading { font-family:'Caveat',cursive; font-size:1.6rem; color:var(--ink); margin-bottom:20px; border-bottom:2px dashed rgba(139,99,64,0.3); padding-bottom:10px; }
.auth-form label { display:block; font-size:0.82rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink2); margin-bottom:5px; margin-top:14px; }
.auth-form input { width:100%; padding:10px 14px; border:2px solid rgba(139,99,64,0.25); border-radius:10px; font-family:'Lato',sans-serif; font-size:0.95rem; background:rgba(255,255,255,0.8); color:var(--ink); transition:border-color 0.2s; }
.auth-form input:focus { outline:none; border-color:var(--accent2); background:#fff; }

.two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.full { grid-column:1/-1; }

.btn-primary { width:100%; margin-top:20px; padding:12px; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:white; border:none; border-radius:12px; font-size:1rem; font-weight:700; cursor:pointer; font-family:'Lato',sans-serif; letter-spacing:0.04em; transition:transform 0.15s,box-shadow 0.15s; box-shadow:0 4px 16px rgba(192,57,43,0.35); }
.btn-primary:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(192,57,43,0.45); }
.btn-primary:disabled { opacity:0.6; cursor:not-allowed; transform:none; }
.btn-cancel { flex:1; padding:12px; background:rgba(139,99,64,0.12); border:2px solid rgba(139,99,64,0.25); border-radius:12px; font-size:0.95rem; cursor:pointer; font-family:'Lato',sans-serif; color:var(--ink2); transition:background 0.2s; }
.btn-cancel:hover { background:rgba(139,99,64,0.2); }
.auth-links { display:flex; justify-content:space-between; margin-top:14px; flex-wrap:wrap; gap:8px; }
.link { color:var(--accent); cursor:pointer; font-size:0.88rem; text-decoration:underline; text-underline-offset:3px; }
.link:hover { color:var(--accent2); }

/* Layout */
.layout { display:flex; min-height:100vh; }
.sidebar { width:var(--sidebar-w); background:rgba(44,24,16,0.92); backdrop-filter:blur(12px); display:flex; flex-direction:column; padding:20px 0; transition:width 0.25s ease; position:fixed; top:0; left:0; height:100vh; z-index:100; overflow:visible; border-right:1px solid rgba(255,255,255,0.08); }
.sidebar.expanded { width:var(--sidebar-exp); }
.sb-logo { font-family:'Caveat',cursive; font-size:1.1rem; color:var(--cream); padding:0 18px; margin-bottom:30px; white-space:nowrap; font-weight:700; }
.sb-nav { flex:1; display:flex; flex-direction:column; gap:6px; }
.sb-item { display:flex; align-items:center; gap:14px; padding:14px 20px; cursor:pointer; color:rgba(245,237,216,0.65); border-left:3px solid transparent; transition:all 0.2s; white-space:nowrap; }
.sb-item:hover,.sb-item.active { color:var(--cream); background:rgba(255,255,255,0.08); border-left-color:var(--accent2); }
.sb-icon { font-size:1.35rem; flex-shrink:0; }
.sb-label { font-size:0.9rem; font-weight:600; }

/* Account area */
.sb-acct-wrap { position:relative; border-top:1px solid rgba(255,255,255,0.1); }
.sb-user { display:flex; align-items:center; gap:14px; padding:14px 20px; cursor:pointer; color:rgba(245,237,216,0.65); transition:all 0.2s; white-space:nowrap; }
.sb-user:hover { color:var(--cream); background:rgba(255,255,255,0.08); }

/* Account popup */
.acct-popup { position:absolute; bottom:calc(100% + 8px); left:4px; width:220px; background:#fff; border-radius:14px; box-shadow:0 8px 32px rgba(0,0,0,0.25); z-index:500; overflow:hidden; border:1px solid rgba(139,99,64,0.15); animation:popIn 0.15s ease; }
.dark .acct-popup { background:#2a2a3e; border-color:rgba(255,255,255,0.1); }
@keyframes popIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.acct-popup-header { padding:14px 16px 10px; }
.acct-popup-name { font-weight:700; color:var(--ink); font-size:0.95rem; }
.acct-popup-email { font-size:0.78rem; color:var(--ink2); margin-top:2px; word-break:break-all; }
.acct-popup-divider { height:1px; background:rgba(139,99,64,0.15); margin:4px 0; }
.acct-popup-item { display:flex; align-items:center; gap:10px; padding:10px 16px; cursor:pointer; font-size:0.9rem; color:var(--ink); transition:background 0.15s; }
.acct-popup-item:hover { background:rgba(139,99,64,0.08); }
.acct-popup-item span:first-child { font-size:1rem; }
.acct-logout { color:#e74c3c !important; }
.acct-logout:hover { background:rgba(231,76,60,0.08) !important; }

.main { margin-left:var(--sidebar-w); flex:1; padding:32px 28px; transition:margin-left 0.25s; }
.main-inner { max-width:960px; margin:0 auto; }

/* Page header */
.page-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px; flex-wrap:wrap; gap:14px; }
.page-title { font-family:'Caveat',cursive; font-size:2.4rem; color:var(--cream); text-shadow:0 2px 8px rgba(0,0,0,0.4); }
.page-sub { color:rgba(245,237,216,0.7); font-size:0.88rem; margin-top:3px; }
.page-header .btn-primary { width:auto; margin-top:0; }

/* Modal */
.modal-bg { position:fixed; inset:0; background:rgba(44,24,16,0.75); backdrop-filter:blur(6px); z-index:200; display:flex; align-items:center; justify-content:center; padding:20px; }
.modal { background:var(--paper); border-radius:20px; padding:36px; width:100%; max-width:580px; max-height:90vh; overflow-y:auto; box-shadow:0 24px 64px rgba(0,0,0,0.5); border-top:4px solid var(--accent2); }
.modal-title { font-family:'Caveat',cursive; font-size:1.8rem; color:var(--ink); margin-bottom:22px; border-bottom:2px dashed rgba(139,99,64,0.25); padding-bottom:12px; }
.todo-form label { display:block; font-size:0.8rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink2); margin-bottom:5px; margin-top:14px; }
.todo-form input,.todo-form select,.todo-form textarea { width:100%; padding:10px 14px; border:2px solid rgba(139,99,64,0.2); border-radius:10px; font-family:'Lato',sans-serif; font-size:0.95rem; background:rgba(255,255,255,0.8); color:var(--ink); transition:border-color 0.2s; }
.dark .todo-form input,.dark .todo-form select,.dark .todo-form textarea { background:rgba(255,255,255,0.1); color:var(--ink); }
.todo-form input:focus,.todo-form select:focus,.todo-form textarea:focus { outline:none; border-color:var(--accent2); background:#fff; }
.form-actions { display:flex; gap:12px; margin-top:22px; }
.form-actions .btn-primary { flex:2; margin-top:0; }

/* Priority */
.priority-row { display:flex; gap:8px; margin-top:6px; }
.priority-btn { flex:1; padding:8px; border:2px solid var(--pc); border-radius:10px; background:transparent; cursor:pointer; font-weight:700; font-family:'Lato',sans-serif; font-size:0.88rem; color:var(--pc); transition:all 0.15s; }
.priority-btn.active { background:var(--pc); color:white; }
.priority-btn:hover { opacity:0.85; }

/* Profile info */
.profile-info { background:rgba(139,99,64,0.06); border-radius:10px; padding:14px; margin-bottom:16px; }
.profile-row { display:flex; gap:12px; padding:6px 0; border-bottom:1px dashed rgba(139,99,64,0.15); }
.profile-row:last-child { border-bottom:none; }
.profile-label { font-size:0.8rem; font-weight:700; text-transform:uppercase; color:var(--ink2); width:80px; flex-shrink:0; }
.profile-value { font-size:0.9rem; color:var(--ink); word-break:break-all; }

/* About modal */
.about-version { font-size:1.1rem; font-weight:700; color:var(--accent2); margin:4px 0 12px; }
.about-desc { font-size:0.95rem; color:var(--ink2); line-height:1.6; margin-bottom:16px; }
.about-meta { display:flex; flex-direction:column; gap:8px; background:rgba(139,99,64,0.06); border-radius:10px; padding:14px; font-size:0.88rem; color:var(--ink2); }

/* Feedback */
.feedback-subtitle { font-size:0.92rem; color:var(--ink2); margin-bottom:4px; font-style:italic; }

/* Todo Cards */
.todos-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:18px; }
.empty-state { grid-column:1/-1; text-align:center; color:rgba(245,237,216,0.7); padding:60px 20px; font-size:1.05rem; }
.empty-icon { font-size:3rem; margin-bottom:12px; }
.todo-card { background:var(--bg-card); border-radius:14px; padding:20px; box-shadow:0 4px 20px rgba(0,0,0,0.2); border-left:4px solid var(--wood); transition:transform 0.2s,box-shadow 0.2s; animation:cardIn 0.3s ease; }
@keyframes cardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.todo-card:hover{transform:translateY(-3px);box-shadow:0 8px 28px rgba(0,0,0,0.28)}
.todo-card.status-completed{border-left-color:var(--green)} .todo-card.status-expired{border-left-color:#e74c3c} .todo-card.status-inprogress{border-left-color:#f5a623}
.todo-card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;gap:6px}
.todo-badge{display:inline-block;padding:3px 10px;border-radius:20px;color:white;font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em}
.todo-actions{display:flex;gap:6px;flex-shrink:0} .icon-btn{background:none;border:none;cursor:pointer;font-size:1rem;padding:4px;border-radius:6px;transition:background 0.15s} .icon-btn:hover{background:rgba(139,99,64,0.12)}
.todo-activity{font-family:'Caveat',cursive;font-size:1.25rem;font-weight:700;color:var(--ink);margin-bottom:5px}
.todo-id{font-size:0.72rem;color:rgba(92,64,51,0.55);margin-bottom:10px}
.todo-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px} .todo-meta span{background:rgba(139,99,64,0.1);padding:3px 9px;border-radius:8px;font-size:0.78rem;color:var(--ink2)}
.todo-comments{font-size:0.83rem;color:var(--ink2);font-style:italic;border-top:1px dashed rgba(139,99,64,0.2);padding-top:8px;margin-top:6px;white-space:pre-wrap}
.todo-date{font-size:0.73rem;color:rgba(92,64,51,0.5);margin-top:8px}

/* History */
.history-list{display:flex;flex-direction:column;gap:12px}
.history-group{background:var(--bg-card);border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.18)}
.history-date-row{display:flex;align-items:center;gap:12px;padding:16px 20px;cursor:pointer;background:rgba(139,99,64,0.08);border-bottom:1px solid rgba(139,99,64,0.1);transition:background 0.15s}
.history-date-row:hover{background:rgba(139,99,64,0.14)} .history-expand{font-size:0.7rem;color:var(--ink2)}
.history-date-label{font-family:'Caveat',cursive;font-size:1.15rem;font-weight:700;color:var(--ink);flex:1}
.history-count{font-size:0.8rem;color:var(--ink2)} .today-badge{background:var(--accent);color:white;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:20px}
.history-items{padding:14px;display:flex;flex-direction:column;gap:10px} .history-empty{text-align:center;color:var(--ink2);font-style:italic;font-size:0.88rem}
.history-card{background:var(--paper);border-radius:10px;padding:14px 16px;border-left:3px solid var(--wood)}
.hc-top{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap} .hc-id{font-size:0.72rem;color:rgba(92,64,51,0.5)}
.hc-activity{font-family:'Caveat',cursive;font-size:1.1rem;font-weight:700;color:var(--ink);margin-bottom:6px}

/* TimePicker */
.tp-wrap{position:relative} .tp-field{display:flex;align-items:center;border:2px solid rgba(139,99,64,0.2);border-radius:10px;background:rgba(255,255,255,0.8);cursor:pointer;transition:border-color 0.2s} .tp-field:hover{border-color:var(--accent2)}
.tp-clock{padding:10px 10px 10px 12px;font-size:1rem} .tp-input{flex:1;border:none!important;background:transparent!important;cursor:pointer;padding:10px 14px 10px 0!important;color:var(--ink)}
.tp-popup{position:absolute;top:110%;left:0;background:var(--paper);border-radius:14px;padding:18px;box-shadow:0 8px 32px rgba(0,0,0,0.25);z-index:300;min-width:220px;border:1px solid rgba(139,99,64,0.15)}
.tp-title{font-family:'Caveat',cursive;font-size:1.05rem;color:var(--ink);margin-bottom:12px}
.tp-row{display:flex;align-items:center;gap:8px;margin-bottom:12px} .tp-row button{background:rgba(139,99,64,0.1);border:none;border-radius:6px;width:28px;height:28px;cursor:pointer;font-size:1rem;color:var(--ink2);transition:background 0.15s} .tp-row button:hover{background:rgba(139,99,64,0.22)}
.tp-num{width:46px;text-align:center;border:2px solid rgba(139,99,64,0.2);border-radius:8px;padding:4px;font-size:1rem;font-weight:700;color:var(--ink);background:white} .tp-num:focus{outline:none;border-color:var(--accent2)}
.tp-colon{font-size:1.3rem;font-weight:700;color:var(--ink2)} .tp-ampm{display:flex;gap:8px;margin-bottom:12px}
.tp-ampm button{flex:1;padding:7px;border:2px solid rgba(139,99,64,0.2);border-radius:8px;background:transparent;cursor:pointer;font-weight:700;color:var(--ink2);transition:all 0.15s} .tp-ampm button.active{background:var(--accent2);color:white;border-color:var(--accent2)}
.tp-ok{width:100%;padding:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:white;border:none;border-radius:10px;cursor:pointer;font-weight:700;font-family:'Lato',sans-serif;transition:opacity 0.15s} .tp-ok:hover{opacity:0.9}

/* Toast */
.toast{position:fixed;bottom:28px;right:28px;background:var(--ink);color:var(--cream);padding:13px 22px;border-radius:12px;font-size:0.9rem;font-weight:600;z-index:999;box-shadow:0 6px 24px rgba(0,0,0,0.35);animation:slideUp 0.3s ease;border-left:4px solid var(--green);max-width:380px;line-height:1.5}
.toast.error{border-left-color:#e74c3c}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

/* Scrollbar */
::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:rgba(139,99,64,0.05)} ::-webkit-scrollbar-thumb{background:rgba(139,99,64,0.3);border-radius:4px}

/* ── AI Chatbot ── */
.chat-bubble{position:fixed;bottom:28px;right:28px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;font-size:1.5rem;cursor:pointer;box-shadow:0 4px 20px rgba(192,57,43,0.45);z-index:998;transition:all 0.2s;display:flex;align-items:center;justify-content:center;color:white;font-weight:700}
.chat-bubble:hover{transform:scale(1.1);box-shadow:0 8px 28px rgba(192,57,43,0.55)}
.chat-bubble.open{background:rgba(44,24,16,0.9)}
.chat-panel{position:fixed;bottom:96px;right:28px;width:360px;height:500px;background:var(--paper);border-radius:20px;box-shadow:0 16px 48px rgba(0,0,0,0.3);z-index:997;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(139,99,64,0.15);animation:popIn 0.2s ease}
.dark .chat-panel{background:#1e1e2e;border-color:rgba(255,255,255,0.1)}
.chat-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:white;flex-shrink:0}
.chat-header-info{display:flex;align-items:center;gap:10px}
.chat-avatar{font-size:1.5rem}
.chat-title{font-weight:700;font-size:0.95rem}
.chat-subtitle{font-size:0.72rem;opacity:0.85}
.chat-close{background:none;border:none;color:white;font-size:1.1rem;cursor:pointer;opacity:0.8;padding:4px;border-radius:6px;transition:opacity 0.15s}
.chat-close:hover{opacity:1}
.chat-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.chat-msg{display:flex;gap:8px;align-items:flex-end}
.chat-msg.user{flex-direction:row-reverse}
.chat-msg-avatar{font-size:1.2rem;flex-shrink:0}
.chat-msg-bubble{max-width:80%;padding:10px 14px;border-radius:16px;font-size:0.88rem;line-height:1.5;word-break:break-word}
.chat-msg.ai .chat-msg-bubble{background:rgba(139,99,64,0.1);color:var(--ink);border-bottom-left-radius:4px}
.dark .chat-msg.ai .chat-msg-bubble{background:rgba(255,255,255,0.08);color:var(--ink)}
.chat-msg.user .chat-msg-bubble{background:linear-gradient(135deg,var(--accent),var(--accent2));color:white;border-bottom-right-radius:4px}
.chat-typing{display:flex;gap:5px;align-items:center;padding:12px 14px}
.chat-typing span{width:7px;height:7px;border-radius:50%;background:var(--ink2);animation:bounce 1.2s ease infinite}
.chat-typing span:nth-child(2){animation-delay:.2s}.chat-typing span:nth-child(3){animation-delay:.4s}
.chat-suggestions{padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-top:1px solid rgba(139,99,64,0.1)}
.chat-suggestion{background:rgba(139,99,64,0.08);border:1px solid rgba(139,99,64,0.2);border-radius:20px;padding:5px 12px;font-size:0.75rem;cursor:pointer;color:var(--ink2);font-family:Lato,sans-serif;transition:all 0.15s;white-space:nowrap}
.chat-suggestion:hover{background:rgba(139,99,64,0.18);color:var(--ink)}
.chat-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(139,99,64,0.1);flex-shrink:0}
.chat-input{flex:1;padding:10px 14px;border:2px solid rgba(139,99,64,0.2);border-radius:12px;font-family:Lato,sans-serif;font-size:0.9rem;background:rgba(255,255,255,0.8);color:var(--ink);outline:none;transition:border-color 0.2s}
.dark .chat-input{background:rgba(255,255,255,0.08);color:var(--ink)}
.chat-input:focus{border-color:var(--accent2)}
.chat-send{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:12px;width:42px;height:42px;cursor:pointer;color:white;font-size:1rem;flex-shrink:0;transition:opacity 0.15s;display:flex;align-items:center;justify-content:center}
.chat-send:hover{opacity:0.85}
.chat-send:disabled{opacity:0.4;cursor:not-allowed}
`;
