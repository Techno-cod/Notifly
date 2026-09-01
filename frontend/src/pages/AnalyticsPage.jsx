import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { getAnalytics } from "../services/api";

function StatCard({ label, value, sub, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    green: "text-green-600",
    red: "text-red-500",
    amber: "text-amber-600",
  };
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function AnalyticsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("notifly_token");
    if (!token) {
      navigate("/login");
      return;
    }
    const fetchData = async () => {
      try {
        const result = await getAnalytics();
        setData(result);
      } catch (err) {
        setError("Failed to load analytics");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-slate-400">Loading analytics...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-red-500">{error || "No data"}</p>
      </div>
    );
  }

  const { summary, byChannel, byEventType, latency, digest, deadLetterCount, recentActivity } = data;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto">

        <div className="flex justify-between items-center mb-6">
          <div>
            <Link to="/dashboard" className="text-sm text-slate-500 hover:text-slate-800">
              ← Back to Dashboard
            </Link>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">📊 Analytics</h1>
          </div>
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard label="Delivery Rate" value={`${summary.deliveryRate}%`} tone="green" />
          <StatCard label="Failure Rate" value={`${summary.failureRate}%`} tone={summary.failureRate > 0 ? "red" : "slate"} />
          <StatCard label="Total Notifications" value={summary.total} />
          <StatCard label="Dead Letters" value={deadLetterCount} tone={deadLetterCount > 0 ? "amber" : "slate"} />
        </div>

        {/* Latency */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">Delivery Latency</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-slate-400">Average</p>
              <p className="text-xl font-semibold text-slate-900">
                {latency.avgMs !== null ? `${latency.avgMs}ms` : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Min</p>
              <p className="text-xl font-semibold text-slate-900">
                {latency.minMs !== null ? `${latency.minMs}ms` : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Max</p>
              <p className="text-xl font-semibold text-slate-900">
                {latency.maxMs !== null ? `${latency.maxMs}ms` : "—"}
              </p>
            </div>
          </div>
        </div>

        {/* Channel breakdown */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">By Channel</h2>
          <div className="space-y-3">
            {byChannel.map((c) => {
              const total = parseInt(c.total, 10);
              const sent = parseInt(c.sent, 10);
              const pct = total > 0 ? ((sent / total) * 100).toFixed(0) : 0;
              return (
                <div key={c.channel}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-slate-700 capitalize">
                      {c.channel === "in_app" ? "In-App" : "Email"}
                    </span>
                    <span className="text-slate-500">
                      {sent}/{total} sent ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div
                      className="bg-slate-900 h-2 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Digest vs immediate */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">Delivery Type</h2>
          <div className="flex gap-6">
            <div>
              <p className="text-xs text-slate-400">Immediate</p>
              <p className="text-2xl font-bold text-slate-900">{digest.immediateCount}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">📦 Digest</p>
              <p className="text-2xl font-bold text-amber-600">{digest.digestCount}</p>
            </div>
          </div>
        </div>

        {/* Event types */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">By Event Type</h2>
          <div className="space-y-2">
            {byEventType.map((e) => (
              <div key={e.event_type} className="flex justify-between text-sm">
                <span className="text-slate-700">{e.event_type}</span>
                <span className="text-slate-500">{e.sent}/{e.total} sent</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="font-semibold text-slate-900 mb-4">Recent Activity</h2>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {recentActivity.map((r, i) => (
              <div key={i} className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                <div>
                  <span className="font-medium text-slate-700">{r.event_type}</span>
                  <span className="text-slate-400 ml-2">via {r.channel}</span>
                </div>
                <div className="flex items-center gap-2">
                  {r.error && (
                    <span className="text-xs text-red-400" title={r.error}>
                      {r.error}
                    </span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      r.status === "sent"
                        ? "bg-green-50 text-green-700"
                        : r.status === "failed"
                        ? "bg-red-50 text-red-600"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

export default AnalyticsPage;