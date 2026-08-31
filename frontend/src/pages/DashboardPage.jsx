import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { sendEvent } from "../services/api";

function DashboardPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem("notifly_token");
    const storedUser = localStorage.getItem("notifly_user");
    if (!token || !storedUser) {
      navigate("/login");
      return;
    }
    const parsedUser = JSON.parse(storedUser);
    setUser(parsedUser);

    // Connect to Socket.io
    const socket = io("http://localhost:3000");
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[Socket] Connected:", socket.id);
      setConnected(true);
      socket.emit("subscribe", parsedUser.id);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("notification", (data) => {
      console.log("[Socket] Notification received:", data);
      setNotifications((prev) => [
        { ...data, id: Date.now(), receivedAt: new Date().toISOString() },
        ...prev,
      ]);
    });

    return () => socket.disconnect();
  }, [navigate]);

  const handleTestEvent = async () => {
    try {
      await sendEvent({
        type: "order.placed",
        userId: user.id,
        data: { orderId: Math.floor(Math.random() * 10000), amount: 299 },
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("notifly_token");
    localStorage.removeItem("notifly_user");
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-2xl mx-auto">

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">🔔 Notifly</h1>
            <p className="text-sm text-slate-500">Welcome, {user?.name}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ${
              connected ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}></span>
              {connected ? "Live" : "Disconnected"}
            </span>
            <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-800">
              Logout
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="font-semibold text-slate-900 mb-2">Test the pipeline</h2>
          <p className="text-sm text-slate-500 mb-4">
            Send a test event through Notifly — you'll see it appear below instantly, and an email will be sent to your inbox.
          </p>
          <button
            onClick={handleTestEvent}
            className="bg-slate-900 text-white px-5 py-2.5 rounded-xl font-medium hover:bg-slate-800 transition"
          >
            Send test order.placed event
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="font-semibold text-slate-900 mb-4">
            Live notifications ({notifications.length})
          </h2>
          {notifications.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">
              No notifications yet — click the button above
            </p>
          ) : (
            <div className="space-y-3">
              {notifications.map((n) => (
                <div key={n.id} className="border border-slate-100 rounded-xl p-4 animate-in fade-in slide-in-from-top-2">
                  <div className="flex justify-between items-start">
                    <span className="text-sm font-medium text-slate-900">{n.type}</span>
                    <span className="text-xs text-slate-400">
                      {new Date(n.receivedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <pre className="text-xs text-slate-500 mt-2 bg-slate-50 rounded-lg p-2 overflow-x-auto">
                    {JSON.stringify(n.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

export default DashboardPage;