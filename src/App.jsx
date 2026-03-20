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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const genId = () =>
  `TODO-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
const last7 = () => {
  const a = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    a.push(d.toISOString().slice(0, 10));
  }
  return a;
};

// ─── TimePicker ───────────────────────────────────────────────────────────────
function TimePicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const raw = value ? parseInt(value.split(":")[0]) : 0;
  const [h, setH] = useState(raw === 0 ? 12 : raw > 12 ? raw - 12 : raw);
  const [m, setM] = useState(value ? parseInt(value.split(":")[1]) : 0);
  const [am, setAm] = useState(value ? (raw < 12 ? "AM" : "PM") : "AM");
  const ref = useRef();

  useEffect(() => {
    const fn = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const commit = () => {
    let hour = h % 12;
    if (am === "PM") hour += 12;
    onChange(`${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    setOpen(false);
  };

  const display = value
    ? (() => {
        const [hh, mm] = value.split(":");
        const ih = parseInt(hh);
        const disp = ih === 0 ? 12 : ih > 12 ? ih - 12 : ih;
        return `${disp}:${mm} ${ih < 12 ? "AM" : "PM"}`;
      })()
    : "";

  return (
    <div className="tp-wrap" ref={ref}>
      <div className="tp-field" onClick={() => setOpen((o) => !o)}>
        <span className="tp-clock">🕐</span>
        <input
          readOnly
          value={display}
          placeholder={label}
          className="tp-input"
          onChange={() => {}}
        />
      </div>
      {open && (
        <div className="tp-popup">
          <div className="tp-title">{label}</div>
          <div className="tp-clock-face">
            <div className="tp-row">
              <button onClick={() => setH((h) => (h > 1 ? h - 1 : 12))}>‹</button>
              <input
                className="tp-num"
                value={h}
                onChange={(e) =>
                  setH(Math.max(1, Math.min(12, parseInt(e.target.value) || 1)))
                }
              />
              <button onClick={() => setH((h) => (h < 12 ? h + 1 : 1))}>›</button>
              <span className="tp-colon">:</span>
              <button onClick={() => setM((m) => (m > 0 ? m - 1 : 59))}>‹</button>
              <input
                className="tp-num"
                value={String(m).padStart(2, "0")}
                onChange={(e) =>
                  setM(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))
                }
              />
              <button onClick={() => setM((m) => (m < 59 ? m + 1 : 0))}>›</button>
            </div>
            <div className="tp-ampm">
              <button
                className={am === "AM" ? "active" : ""}
                onClick={() => setAm("AM")}
              >
                AM
              </button>
              <button
                className={am === "PM" ? "active" : ""}
                onClick={() => setAm("PM")}
              >
                PM
              </button>
            </div>
          </div>
          <button className="tp-ok" onClick={commit}>
            Set Time
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [authUser, setAuthUser]       = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [todos, setTodos]             = useState([]);
  const [page, setPage]               = useState("loading");
  const [sidebar, setSidebar]         = useState(false);
  const [toast, setToast]             = useState(null);
  const [editTodo, setEditTodo]       = useState(null);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
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
        setAuthUser(null);
        setUserProfile(null);
        setTodos([]);
        setPage("signin");
      }
    });
    return unsub;
  }, []);

  // ── Real-time todos listener ──────────────────────────────────────────────
  useEffect(() => {
    if (!authUser) return;
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const unsub = onSnapshot(doc(db, "todos", authUser.uid), (snap) => {
      if (snap.exists()) {
        const items = (snap.data().items || []).filter(
          (t) => new Date(t.createdDate) >= cutoff
        );
        setTodos(items);
      } else {
        setTodos([]);
      }
    });
    return unsub;
  }, [authUser]);

  // ── Expiry checker (runs every 60s) ───────────────────────────────────────
  useEffect(() => {
    if (!authUser || !userProfile) return;
    const check = async () => {
      const snap = await getDoc(doc(db, "todos", authUser.uid));
      if (!snap.exists()) return;
      const items = snap.data().items || [];
      const now   = new Date();
      let changed = false;
      const updated = items.map((t) => {
        if (
          (t.status === "new" || t.status === "inprogress") &&
          t.endTime
        ) {
          const end = new Date(`${today()}T${t.endTime}`);
          if (now > end) {
            changed = true;
            sendTaskExpiredEmail(
              authUser.email,
              userProfile.firstName,
              t.activity
            );
            const comments =
              (t.comments || "") +
              (t.comments ? "\n" : "") +
              "Task not completed on time";
            return { ...t, status: "expired", comments };
          }
        }
        return t;
      });
      if (changed) {
        await setDoc(doc(db, "todos", authUser.uid), { items: updated });
      }
    };
    check();
    const iv = setInterval(check, 60000);
    return () => clearInterval(iv);
  }, [authUser, userProfile]);

  // ── Auth forms ────────────────────────────────────────────────────────────
  const [signupForm, setSignupForm] = useState({
    firstName: "", lastName: "", email: "", password: "",
  });
  const [signinForm, setSigninForm] = useState({ email: "", password: "" });
  const [forgotEmail, setForgotEmail] = useState("");

  const handleSignup = async (e) => {
    e.preventDefault();
    try {
      const cred = await createUserWithEmailAndPassword(
        auth, signupForm.email, signupForm.password
      );
      await updateProfile(cred.user, {
        displayName: `${signupForm.firstName} ${signupForm.lastName}`,
      });
      const profile = {
        firstName: signupForm.firstName,
        lastName:  signupForm.lastName,
        email:     signupForm.email.toLowerCase(),
      };
      await setDoc(doc(db, "users", cred.user.uid), profile);
      setUserProfile(profile);
      showToast(`Welcome, ${signupForm.firstName}! 🎉`);
    } catch (err) {
      const msg =
        err.code === "auth/email-already-in-use"
          ? "Email already registered"
          : err.code === "auth/weak-password"
          ? "Password must be at least 6 characters"
          : "Sign up failed – check your details";
      showToast(msg, "error");
    }
  };

  const handleSignin = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, signinForm.email, signinForm.password);
    } catch {
      showToast("Invalid email or password", "error");
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    try {
      await sendPasswordResetEmail(auth, forgotEmail);
      showToast("Reset link sent! Check your inbox 📬");
      setPage("signin");
    } catch {
      showToast("Email not found", "error");
    }
  };

  const handleLogout = () => signOut(auth);

  // ── Todo helpers ──────────────────────────────────────────────────────────
  const BLANK_FORM = {
    activity: "", status: "new", estimateTime: "",
    startTime: "", endTime: "", actualTime: "", comments: "",
  };
  const [todoForm, setTodoForm]   = useState(BLANK_FORM);
  const [formOpen, setFormOpen]   = useState(false);

  const saveTodos = (items) =>
    setDoc(doc(db, "todos", authUser.uid), { items });

  const handleTodoSubmit = async (e) => {
    e.preventDefault();
    if (!todoForm.activity || !todoForm.estimateTime)
      return showToast("Activity & Estimate Time are required", "error");

    let newItems;
    if (editTodo) {
      newItems = todos.map((t) =>
        t.id === editTodo.id ? { ...t, ...todoForm } : t
      );
      showToast("Task updated ✏️");
    } else {
      const newTodo = {
        ...todoForm,
        id: genId(),
        createdDate: today(),
        createdAt: new Date().toISOString(),
      };
      newItems = [...todos, newTodo];
      showToast("Task created ✅");
    }
    await saveTodos(newItems);
    setTodoForm(BLANK_FORM);
    setFormOpen(false);
    setEditTodo(null);
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
      estimateTime: todo.estimateTime,
      startTime:    todo.startTime  || "",
      endTime:      todo.endTime    || "",
      actualTime:   todo.actualTime || "",
      comments:     todo.comments   || "",
    });
    setFormOpen(true);
  };

  const STATUS_COLOR = {
    new: "#4a9eff", inprogress: "#f5a623",
    completed: "#27ae60", expired: "#e74c3c",
  };
  const STATUS_LABEL = {
    new: "New", inprogress: "In Progress",
    completed: "Completed", expired: "Expired",
  };

  // ── History ───────────────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState({});
  const days = last7();
  const grouped = days.reduce((acc, d) => {
    acc[d] = todos.filter((t) => t.createdDate === d);
    return acc;
  }, {});

  // ── Loading splash ────────────────────────────────────────────────────────
  if (page === "loading") {
    return (
      <div className="loading-screen">
        <div className="loading-logo">📋</div>
        <div className="loading-name">TaskNest</div>
        <div className="loading-dot-row">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <style>{CSS}</style>

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type || ""}`}>{toast.msg}</div>
      )}

      {/* ── AUTH PAGES ── */}
      {(page === "signin" || page === "signup" || page === "forgot") && (
        <div className="auth-bg">
          <div className="auth-card">
            <div className="auth-logo">📋 TaskNest</div>
            <div className="auth-subtitle">Your cozy productivity corner</div>

            {page === "signin" && (
              <>
                <h2 className="auth-heading">Sign In</h2>
                <form onSubmit={handleSignin} className="auth-form">
                  <label>Email Address</label>
                  <input
                    type="email" required
                    value={signinForm.email}
                    onChange={(e) => setSigninForm({ ...signinForm, email: e.target.value })}
                    placeholder="you@example.com"
                  />
                  <label>Password</label>
                  <input
                    type="password" required
                    value={signinForm.password}
                    onChange={(e) => setSigninForm({ ...signinForm, password: e.target.value })}
                    placeholder="••••••••"
                  />
                  <button type="submit" className="btn-primary">Sign In</button>
                  <div className="auth-links">
                    <span onClick={() => setPage("forgot")} className="link">
                      Forgot Password?
                    </span>
                    <span onClick={() => setPage("signup")} className="link">
                      Create Account
                    </span>
                  </div>
                </form>
              </>
            )}

            {page === "signup" && (
              <>
                <h2 className="auth-heading">Create Account</h2>
                <form onSubmit={handleSignup} className="auth-form">
                  <div className="two-col">
                    <div>
                      <label>First Name</label>
                      <input
                        required
                        value={signupForm.firstName}
                        onChange={(e) => setSignupForm({ ...signupForm, firstName: e.target.value })}
                        placeholder="Jane"
                      />
                    </div>
                    <div>
                      <label>Last Name</label>
                      <input
                        required
                        value={signupForm.lastName}
                        onChange={(e) => setSignupForm({ ...signupForm, lastName: e.target.value })}
                        placeholder="Doe"
                      />
                    </div>
                  </div>
                  <label>Email Address</label>
                  <input
                    type="email" required
                    value={signupForm.email}
                    onChange={(e) => setSignupForm({ ...signupForm, email: e.target.value })}
                    placeholder="you@example.com"
                  />
                  <label>Password</label>
                  <input
                    type="password" required minLength={6}
                    value={signupForm.password}
                    onChange={(e) => setSignupForm({ ...signupForm, password: e.target.value })}
                    placeholder="Min 6 characters"
                  />
                  <button type="submit" className="btn-primary">Create Account</button>
                  <div className="auth-links">
                    <span onClick={() => setPage("signin")} className="link">
                      Already have an account? Sign In
                    </span>
                  </div>
                </form>
              </>
            )}

            {page === "forgot" && (
              <>
                <h2 className="auth-heading">Reset Password</h2>
                <form onSubmit={handleForgot} className="auth-form">
                  <label>Email Address</label>
                  <input
                    type="email" required
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <button type="submit" className="btn-primary">
                    Send Reset Link 📬
                  </button>
                  <div className="auth-links">
                    <span onClick={() => setPage("signin")} className="link">
                      ← Back to Sign In
                    </span>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── APP PAGES ── */}
      {(page === "todo" || page === "history") && authUser && userProfile && (
        <div className="layout">
          {/* Sidebar */}
          <div
            className={`sidebar ${sidebar ? "expanded" : ""}`}
            onMouseEnter={() => setSidebar(true)}
            onMouseLeave={() => setSidebar(false)}
          >
            <div className="sb-logo">
              {sidebar ? "📋 TaskNest" : "📋"}
            </div>
            <nav className="sb-nav">
              <div
                className={`sb-item ${page === "todo" ? "active" : ""}`}
                onClick={() => setPage("todo")}
              >
                <span className="sb-icon">✅</span>
                {sidebar && <span className="sb-label">Todo List</span>}
              </div>
              <div
                className={`sb-item ${page === "history" ? "active" : ""}`}
                onClick={() => setPage("history")}
              >
                <span className="sb-icon">🕐</span>
                {sidebar && <span className="sb-label">History</span>}
              </div>
            </nav>
            <div className="sb-user" onClick={handleLogout} title="Logout">
              <span className="sb-icon">👤</span>
              {sidebar && (
                <span className="sb-label">
                  {userProfile.firstName} · Logout
                </span>
              )}
            </div>
          </div>

          {/* Main */}
          <div className="main">
            <div className="main-inner">

              {/* ── TODO PAGE ── */}
              {page === "todo" && (
                <>
                  <div className="page-header">
                    <div>
                      <h1 className="page-title">My Todo List</h1>
                      <div className="page-sub">{fmtDate(new Date())}</div>
                    </div>
                    <button
                      className="btn-primary"
                      onClick={() => {
                        setEditTodo(null);
                        setTodoForm(BLANK_FORM);
                        setFormOpen(true);
                      }}
                    >
                      + New Task
                    </button>
                  </div>

                  {/* Form Modal */}
                  {formOpen && (
                    <div
                      className="modal-bg"
                      onClick={(e) =>
                        e.target.className === "modal-bg" && setFormOpen(false)
                      }
                    >
                      <div className="modal">
                        <h2 className="modal-title">
                          {editTodo ? "Edit Task" : "Create Task"}
                        </h2>
                        <form onSubmit={handleTodoSubmit} className="todo-form">
                          <div className="two-col">
                            <div className="full">
                              <label>Activity Name *</label>
                              <input
                                required
                                value={todoForm.activity}
                                onChange={(e) =>
                                  setTodoForm({ ...todoForm, activity: e.target.value })
                                }
                                placeholder="What needs to be done?"
                              />
                            </div>
                          </div>
                          <div className="two-col">
                            <div>
                              <label>Status</label>
                              <select
                                value={todoForm.status}
                                onChange={(e) =>
                                  setTodoForm({ ...todoForm, status: e.target.value })
                                }
                              >
                                <option value="new">New</option>
                                <option value="inprogress">In Progress</option>
                                <option value="completed">Completed</option>
                                <option value="expired">Expired</option>
                              </select>
                            </div>
                            <div>
                              <label>Estimate Time (mins) *</label>
                              <input
                                type="number" required min="1"
                                value={todoForm.estimateTime}
                                onChange={(e) =>
                                  setTodoForm({ ...todoForm, estimateTime: e.target.value })
                                }
                                placeholder="60"
                              />
                            </div>
                          </div>
                          <div className="two-col">
                            <div>
                              <label>Start Time</label>
                              <TimePicker
                                value={todoForm.startTime}
                                onChange={(v) =>
                                  setTodoForm({ ...todoForm, startTime: v })
                                }
                                label="Start Time"
                              />
                            </div>
                            <div>
                              <label>End Time</label>
                              <TimePicker
                                value={todoForm.endTime}
                                onChange={(v) =>
                                  setTodoForm({ ...todoForm, endTime: v })
                                }
                                label="End Time"
                              />
                            </div>
                          </div>
                          <div className="two-col">
                            <div>
                              <label>Actual Time Taken (mins)</label>
                              <input
                                type="number" min="0"
                                value={todoForm.actualTime}
                                onChange={(e) =>
                                  setTodoForm({ ...todoForm, actualTime: e.target.value })
                                }
                                placeholder="0"
                              />
                            </div>
                          </div>
                          <div>
                            <label>Comments</label>
                            <textarea
                              value={todoForm.comments}
                              onChange={(e) =>
                                setTodoForm({ ...todoForm, comments: e.target.value })
                              }
                              rows={3}
                              placeholder="Any notes..."
                            />
                          </div>
                          <div className="form-actions">
                            <button
                              type="button"
                              className="btn-cancel"
                              onClick={() => {
                                setFormOpen(false);
                                setEditTodo(null);
                              }}
                            >
                              Cancel
                            </button>
                            <button type="submit" className="btn-primary">
                              {editTodo ? "Update Task ✓" : "Create Task ✓"}
                            </button>
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
                      <div
                        key={todo.id}
                        className={`todo-card status-${todo.status}`}
                      >
                        <div className="todo-card-header">
                          <span
                            className="todo-badge"
                            style={{ background: STATUS_COLOR[todo.status] }}
                          >
                            {STATUS_LABEL[todo.status]}
                          </span>
                          <div className="todo-actions">
                            <button
                              className="icon-btn"
                              onClick={() => openEdit(todo)}
                              title="Edit"
                            >
                              ✏️
                            </button>
                            <button
                              className="icon-btn"
                              onClick={() => deleteTodo(todo.id)}
                              title="Delete"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                        <div className="todo-activity">{todo.activity}</div>
                        <div className="todo-id">ID: {todo.id}</div>
                        <div className="todo-meta">
                          {todo.estimateTime && (
                            <span>⏱ Est: {todo.estimateTime} mins</span>
                          )}
                          {todo.startTime && (
                            <span>▶ Start: {todo.startTime}</span>
                          )}
                          {todo.endTime && (
                            <span>⏹ End: {todo.endTime}</span>
                          )}
                          {todo.actualTime && (
                            <span>✅ Actual: {todo.actualTime} mins</span>
                          )}
                        </div>
                        {todo.comments && (
                          <div className="todo-comments">
                            💬 {todo.comments}
                          </div>
                        )}
                        <div className="todo-date">
                          Created: {fmtDate(todo.createdDate)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── HISTORY PAGE ── */}
              {page === "history" && (
                <>
                  <div className="page-header">
                    <div>
                      <h1 className="page-title">History</h1>
                      <div className="page-sub">Last 7 days · Read only</div>
                    </div>
                  </div>
                  <div className="history-list">
                    {[...days].reverse().map((d) => {
                      const items  = grouped[d] || [];
                      const isOpen = expanded[d];
                      return (
                        <div key={d} className="history-group">
                          <div
                            className="history-date-row"
                            onClick={() =>
                              setExpanded((ex) => ({ ...ex, [d]: !ex[d] }))
                            }
                          >
                            <span className="history-expand">
                              {isOpen ? "▼" : "▶"}
                            </span>
                            <span className="history-date-label">
                              {fmtDate(d)}
                            </span>
                            <span className="history-count">
                              {items.length} task
                              {items.length !== 1 ? "s" : ""}
                            </span>
                            {d === today() && (
                              <span className="today-badge">Today</span>
                            )}
                          </div>
                          {isOpen && (
                            <div className="history-items">
                              {items.length === 0 && (
                                <div className="history-empty">
                                  No tasks on this day
                                </div>
                              )}
                              {items.map((todo) => (
                                <div key={todo.id} className="history-card">
                                  <div className="hc-top">
                                    <span
                                      className="todo-badge"
                                      style={{
                                        background: STATUS_COLOR[todo.status],
                                      }}
                                    >
                                      {STATUS_LABEL[todo.status]}
                                    </span>
                                    <span className="hc-id">{todo.id}</span>
                                  </div>
                                  <div className="hc-activity">
                                    {todo.activity}
                                  </div>
                                  <div className="todo-meta">
                                    {todo.estimateTime && (
                                      <span>
                                        ⏱ Est: {todo.estimateTime} mins
                                      </span>
                                    )}
                                    {todo.startTime && (
                                      <span>▶ {todo.startTime}</span>
                                    )}
                                    {todo.endTime && (
                                      <span>⏹ {todo.endTime}</span>
                                    )}
                                    {todo.actualTime && (
                                      <span>
                                        ✅ {todo.actualTime} mins
                                      </span>
                                    )}
                                  </div>
                                  {todo.comments && (
                                    <div className="todo-comments">
                                      💬 {todo.comments}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
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
}

body { font-family: 'Lato', sans-serif; }

/* Loading */
.loading-screen {
  min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--ink);
  color: var(--cream);
  gap: 10px;
}
.loading-logo  { font-size: 3rem; animation: pulse 1.2s ease infinite; }
.loading-name  { font-family:'Caveat',cursive; font-size:2rem; font-weight:700; }
.loading-dot-row { display:flex; gap:8px; margin-top:8px; }
.loading-dot-row span {
  width:8px; height:8px; border-radius:50%; background:var(--accent2);
  animation: bounce 1.2s ease infinite;
}
.loading-dot-row span:nth-child(2) { animation-delay:.2s; }
.loading-dot-row span:nth-child(3) { animation-delay:.4s; }
@keyframes bounce {
  0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-10px)}
}
@keyframes pulse {
  0%,100%{transform:scale(1)} 50%{transform:scale(1.15)}
}

/* App background */
.app {
  min-height: 100vh;
  background:
    linear-gradient(rgba(139,99,64,0.55), rgba(139,99,64,0.65)),
    url('https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?w=1600&q=80') center/cover fixed;
}

/* ── Auth ── */
.auth-bg {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.auth-card {
  background: rgba(253,250,242,0.97);
  border-radius: 20px; padding: 40px;
  width: 100%; max-width: 460px;
  box-shadow: 0 20px 60px rgba(44,24,16,0.4), 0 0 0 1px rgba(139,99,64,0.2);
  border-top: 4px solid var(--accent);
}
.auth-logo {
  font-family:'Caveat',cursive; font-size:2.2rem; font-weight:700;
  color:var(--ink); text-align:center; margin-bottom:4px;
}
.auth-subtitle {
  text-align:center; color:var(--ink2); font-size:0.88rem;
  margin-bottom:28px; font-style:italic;
}
.auth-heading {
  font-family:'Caveat',cursive; font-size:1.6rem; color:var(--ink);
  margin-bottom:20px; border-bottom:2px dashed rgba(139,99,64,0.3); padding-bottom:10px;
}
.auth-form label {
  display:block; font-size:0.82rem; font-weight:700; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--ink2); margin-bottom:5px; margin-top:14px;
}
.auth-form input {
  width:100%; padding:10px 14px;
  border:2px solid rgba(139,99,64,0.25); border-radius:10px;
  font-family:'Lato',sans-serif; font-size:0.95rem;
  background:rgba(255,255,255,0.8); color:var(--ink);
  transition:border-color 0.2s;
}
.auth-form input:focus { outline:none; border-color:var(--accent2); background:#fff; }

/* Shared layout helpers */
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.full    { grid-column:1/-1; }

.btn-primary {
  width:100%; margin-top:20px; padding:12px;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:white; border:none; border-radius:12px;
  font-size:1rem; font-weight:700; cursor:pointer;
  font-family:'Lato',sans-serif; letter-spacing:0.04em;
  transition:transform 0.15s, box-shadow 0.15s;
  box-shadow:0 4px 16px rgba(192,57,43,0.35);
}
.btn-primary:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(192,57,43,0.45); }

.btn-cancel {
  flex:1; padding:12px;
  background:rgba(139,99,64,0.12);
  border:2px solid rgba(139,99,64,0.25); border-radius:12px;
  font-size:0.95rem; cursor:pointer;
  font-family:'Lato',sans-serif; color:var(--ink2);
  transition:background 0.2s;
}
.btn-cancel:hover { background:rgba(139,99,64,0.2); }

.auth-links {
  display:flex; justify-content:space-between;
  margin-top:14px; flex-wrap:wrap; gap:8px;
}
.link {
  color:var(--accent); cursor:pointer; font-size:0.88rem;
  text-decoration:underline; text-underline-offset:3px;
}
.link:hover { color:var(--accent2); }

/* ── Layout ── */
.layout { display:flex; min-height:100vh; }

.sidebar {
  width:var(--sidebar-w);
  background:rgba(44,24,16,0.92);
  backdrop-filter:blur(12px);
  display:flex; flex-direction:column; padding:20px 0;
  transition:width 0.25s ease;
  position:fixed; top:0; left:0; height:100vh;
  z-index:100; overflow:hidden;
  border-right:1px solid rgba(255,255,255,0.08);
}
.sidebar.expanded { width:var(--sidebar-exp); }
.sb-logo {
  font-family:'Caveat',cursive; font-size:1.1rem;
  color:var(--cream); padding:0 18px; margin-bottom:30px;
  white-space:nowrap; font-weight:700;
}
.sb-nav { flex:1; display:flex; flex-direction:column; gap:6px; }
.sb-item {
  display:flex; align-items:center; gap:14px; padding:14px 20px;
  cursor:pointer; color:rgba(245,237,216,0.65);
  border-left:3px solid transparent; transition:all 0.2s; white-space:nowrap;
}
.sb-item:hover, .sb-item.active {
  color:var(--cream); background:rgba(255,255,255,0.08);
  border-left-color:var(--accent2);
}
.sb-icon  { font-size:1.35rem; }
.sb-label { font-size:0.9rem; font-weight:600; }
.sb-user {
  display:flex; align-items:center; gap:14px; padding:14px 20px;
  cursor:pointer; color:rgba(245,237,216,0.55);
  border-top:1px solid rgba(255,255,255,0.1);
  transition:color 0.2s; white-space:nowrap; font-size:0.82rem;
}
.sb-user:hover { color:var(--cream); }

.main { margin-left:var(--sidebar-w); flex:1; padding:32px 28px; transition:margin-left 0.25s; }
.main-inner { max-width:960px; margin:0 auto; }

/* ── Page header ── */
.page-header {
  display:flex; justify-content:space-between; align-items:flex-start;
  margin-bottom:28px; flex-wrap:wrap; gap:14px;
}
.page-title {
  font-family:'Caveat',cursive; font-size:2.4rem;
  color:var(--cream); text-shadow:0 2px 8px rgba(0,0,0,0.4);
}
.page-sub { color:rgba(245,237,216,0.7); font-size:0.88rem; margin-top:3px; }
.page-header .btn-primary { width:auto; margin-top:0; }

/* ── Modal ── */
.modal-bg {
  position:fixed; inset:0;
  background:rgba(44,24,16,0.75); backdrop-filter:blur(6px);
  z-index:200; display:flex; align-items:center; justify-content:center; padding:20px;
}
.modal {
  background:var(--paper); border-radius:20px;
  padding:36px; width:100%; max-width:580px;
  max-height:90vh; overflow-y:auto;
  box-shadow:0 24px 64px rgba(0,0,0,0.5);
  border-top:4px solid var(--accent2);
}
.modal-title {
  font-family:'Caveat',cursive; font-size:1.8rem; color:var(--ink);
  margin-bottom:22px; border-bottom:2px dashed rgba(139,99,64,0.25); padding-bottom:12px;
}
.todo-form label {
  display:block; font-size:0.8rem; font-weight:700; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--ink2); margin-bottom:5px; margin-top:14px;
}
.todo-form input, .todo-form select, .todo-form textarea {
  width:100%; padding:10px 14px;
  border:2px solid rgba(139,99,64,0.2); border-radius:10px;
  font-family:'Lato',sans-serif; font-size:0.95rem;
  background:rgba(255,255,255,0.8); color:var(--ink); transition:border-color 0.2s;
}
.todo-form input:focus, .todo-form select:focus, .todo-form textarea:focus {
  outline:none; border-color:var(--accent2); background:#fff;
}
.form-actions { display:flex; gap:12px; margin-top:22px; }
.form-actions .btn-primary { flex:2; margin-top:0; }

/* ── Todo Cards ── */
.todos-grid {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:18px;
}
.empty-state {
  grid-column:1/-1; text-align:center;
  color:rgba(245,237,216,0.7); padding:60px 20px; font-size:1.05rem;
}
.empty-icon { font-size:3rem; margin-bottom:12px; }

.todo-card {
  background:rgba(253,250,242,0.95); border-radius:14px; padding:20px;
  box-shadow:0 4px 20px rgba(0,0,0,0.2);
  border-left:4px solid var(--wood);
  transition:transform 0.2s,box-shadow 0.2s;
  animation:cardIn 0.3s ease;
}
@keyframes cardIn {
  from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)}
}
.todo-card:hover { transform:translateY(-3px); box-shadow:0 8px 28px rgba(0,0,0,0.28); }
.todo-card.status-completed  { border-left-color:var(--green); }
.todo-card.status-expired    { border-left-color:#e74c3c; }
.todo-card.status-inprogress { border-left-color:#f5a623; }

.todo-card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.todo-badge {
  display:inline-block; padding:3px 10px; border-radius:20px;
  color:white; font-size:0.75rem; font-weight:700;
  text-transform:uppercase; letter-spacing:0.05em;
}
.todo-actions { display:flex; gap:6px; }
.icon-btn {
  background:none; border:none; cursor:pointer; font-size:1rem;
  padding:4px; border-radius:6px; transition:background 0.15s;
}
.icon-btn:hover { background:rgba(139,99,64,0.12); }
.todo-activity {
  font-size:1.05rem; font-weight:700; color:var(--ink); margin-bottom:5px;
  font-family:'Caveat',cursive; font-size:1.25rem;
}
.todo-id { font-size:0.72rem; color:rgba(92,64,51,0.55); margin-bottom:10px; letter-spacing:0.04em; }
.todo-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
.todo-meta span {
  background:rgba(139,99,64,0.1); padding:3px 9px;
  border-radius:8px; font-size:0.78rem; color:var(--ink2);
}
.todo-comments {
  font-size:0.83rem; color:var(--ink2); font-style:italic;
  border-top:1px dashed rgba(139,99,64,0.2);
  padding-top:8px; margin-top:6px; white-space:pre-wrap;
}
.todo-date { font-size:0.73rem; color:rgba(92,64,51,0.5); margin-top:8px; }

/* ── History ── */
.history-list { display:flex; flex-direction:column; gap:12px; }
.history-group {
  background:rgba(253,250,242,0.95); border-radius:14px;
  overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,0.18);
}
.history-date-row {
  display:flex; align-items:center; gap:12px; padding:16px 20px;
  cursor:pointer; background:rgba(139,99,64,0.08);
  border-bottom:1px solid rgba(139,99,64,0.1); transition:background 0.15s;
}
.history-date-row:hover { background:rgba(139,99,64,0.14); }
.history-expand      { font-size:0.7rem; color:var(--ink2); }
.history-date-label  { font-family:'Caveat',cursive; font-size:1.15rem; font-weight:700; color:var(--ink); flex:1; }
.history-count       { font-size:0.8rem; color:var(--ink2); }
.today-badge         { background:var(--accent); color:white; font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:20px; }
.history-items       { padding:14px; display:flex; flex-direction:column; gap:10px; }
.history-empty       { text-align:center; color:var(--ink2); font-style:italic; font-size:0.88rem; }
.history-card {
  background:var(--paper); border-radius:10px;
  padding:14px 16px; border-left:3px solid var(--wood);
}
.hc-top      { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.hc-id       { font-size:0.72rem; color:rgba(92,64,51,0.5); }
.hc-activity { font-family:'Caveat',cursive; font-size:1.1rem; font-weight:700; color:var(--ink); margin-bottom:6px; }

/* ── TimePicker ── */
.tp-wrap  { position:relative; }
.tp-field {
  display:flex; align-items:center;
  border:2px solid rgba(139,99,64,0.2); border-radius:10px;
  background:rgba(255,255,255,0.8); cursor:pointer; transition:border-color 0.2s;
}
.tp-field:hover { border-color:var(--accent2); }
.tp-clock { padding:10px 10px 10px 12px; font-size:1rem; }
.tp-input {
  flex:1; border:none !important; background:transparent !important;
  cursor:pointer; padding:10px 14px 10px 0 !important;
}
.tp-popup {
  position:absolute; top:110%; left:0;
  background:var(--paper); border-radius:14px; padding:18px;
  box-shadow:0 8px 32px rgba(0,0,0,0.25); z-index:300; min-width:220px;
  border:1px solid rgba(139,99,64,0.15);
}
.tp-title { font-family:'Caveat',cursive; font-size:1.05rem; color:var(--ink); margin-bottom:12px; }
.tp-row   { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.tp-row button {
  background:rgba(139,99,64,0.1); border:none; border-radius:6px;
  width:28px; height:28px; cursor:pointer; font-size:1rem; color:var(--ink2);
  transition:background 0.15s;
}
.tp-row button:hover { background:rgba(139,99,64,0.22); }
.tp-num {
  width:46px; text-align:center;
  border:2px solid rgba(139,99,64,0.2); border-radius:8px;
  padding:4px; font-size:1rem; font-weight:700; color:var(--ink); background:white;
}
.tp-num:focus { outline:none; border-color:var(--accent2); }
.tp-colon { font-size:1.3rem; font-weight:700; color:var(--ink2); }
.tp-ampm  { display:flex; gap:8px; margin-bottom:12px; }
.tp-ampm button {
  flex:1; padding:7px; border:2px solid rgba(139,99,64,0.2); border-radius:8px;
  background:transparent; cursor:pointer; font-weight:700; color:var(--ink2);
  transition:all 0.15s;
}
.tp-ampm button.active { background:var(--accent2); color:white; border-color:var(--accent2); }
.tp-ok {
  width:100%; padding:9px;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:white; border:none; border-radius:10px;
  cursor:pointer; font-weight:700; font-family:'Lato',sans-serif; transition:opacity 0.15s;
}
.tp-ok:hover { opacity:0.9; }

/* ── Toast ── */
.toast {
  position:fixed; bottom:28px; right:28px;
  background:var(--ink); color:var(--cream);
  padding:13px 22px; border-radius:12px; font-size:0.9rem; font-weight:600;
  z-index:999; box-shadow:0 6px 24px rgba(0,0,0,0.35);
  animation:slideUp 0.3s ease;
  border-left:4px solid var(--green);
}
.toast.error { border-left-color:#e74c3c; }
@keyframes slideUp {
  from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)}
}

/* ── Scrollbar ── */
::-webkit-scrollbar       { width:6px; }
::-webkit-scrollbar-track { background:rgba(139,99,64,0.05); }
::-webkit-scrollbar-thumb { background:rgba(139,99,64,0.3); border-radius:4px; }
`;
