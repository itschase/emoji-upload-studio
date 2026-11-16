import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookImage,
  Boxes,
  Check,
  CircleUserRound,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Image,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MonitorUp,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  BrowserAsset,
  listAssets,
  makeAsset,
  parseCsv,
  recoverInflight,
  removeAsset,
  sanitizeEmojiName,
  saveAsset,
  saveAssets,
} from "./browser-store";
import { categories, fmt, licenses, pendingDiscordReceipt } from "./lib";
import { Badge, Button, Card, Dialog, Empty } from "./ui";

type Nav = "overview" | "library" | "uploads" | "stats" | "access" | "settings";
type Access = {
  allowed: boolean;
  state: string;
  serverName: string;
  user?: { id: string; username: string; avatar?: string };
  expiresAt?: number;
};
type Worker = {
  id: string;
  win: Window | null;
  ready: boolean;
  batchId?: string;
  assetIds?: string[];
  stage: string;
};
const navigation = [
  ["overview", "Overview", LayoutDashboard],
  ["library", "Library", BookImage],
  ["uploads", "Uploads", MonitorUp],
  ["stats", "Stats", BarChart3],
  ["access", "Access", ShieldCheck],
  ["settings", "Settings", Settings],
] as const;
const authBase = (import.meta.env.VITE_AUTH_URL || location.origin).replace(
  /\/$/,
  "",
);
const studioVersion = "0.9.4";
const userscriptInstallUrl =
  "https://update.greasyfork.org/scripts/605370/Emojigg%20Upload%20Studio%20Worker.user.js";
const compareVersions = (left: string, right: string) => {
  const a = left.split(".").map((value) => Number(value) || 0),
    b = right.split(".").map((value) => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0))
      return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
};
const localPreview =
  ["127.0.0.1", "localhost"].includes(location.hostname) &&
  !import.meta.env.VITE_AUTH_URL;

export function HostedApp() {
  const [nav, setNav] = useState<Nav>("overview"),
    [mobile, setMobile] = useState(false),
    [assets, setAssets] = useState<BrowserAsset[]>([]),
    [loading, setLoading] = useState(true),
    [importOpen, setImportOpen] = useState(false),
    [access, setAccess] = useState<Access>({
      allowed: false,
      state: "checking",
      serverName: "Emote Forge",
    }),
    [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    setAssets(await listAssets());
    setLoading(false);
  }, []);
  useEffect(() => {
    recoverInflight().then(refresh);
  }, [refresh]);
  useEffect(() => {
    const receipt =
      pendingDiscordReceipt || localStorage.getItem("emoteForgeAccess") || "";
    if (pendingDiscordReceipt)
      localStorage.setItem("emoteForgeAccess", pendingDiscordReceipt);
    if (localPreview) {
      setAccess({
        allowed: true,
        state: "development preview",
        serverName: "Emote Forge",
      });
      return;
    }
    fetch(`${authBase}/access/verify`, {
      credentials: "include",
      headers: receipt ? { Authorization: `Bearer ${receipt}` } : {},
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Access verification failed");
        setAccess(body);
      })
      .catch((error) => {
        setAccess({
          allowed: false,
          state: "signed-out",
          serverName: "Emote Forge",
        });
        setNotice(error.message);
      });
  }, []);
  const counts = useMemo(
      () =>
        assets.reduce(
          (result, asset) => (
            (result[asset.status] = (result[asset.status] || 0) + 1),
            result
          ),
          {} as Record<string, number>,
        ),
      [assets],
    ),
    packs = new Set(assets.map((asset) => asset.pack)).size,
    current = navigation.find(([id]) => id === nav)!;
  const signOut = async () => {
    await fetch(`${authBase}/access/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    localStorage.removeItem("emoteForgeAccess");
    location.reload();
  };
  if (!localPreview && !access.allowed) return <AccessGate access={access} />;
  return (
    <div className="app-shell">
      <aside className={mobile ? "sidebar mobile-open" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark">
            <Upload size={18} />
          </span>
          <div>
            <strong>Emote Forge</strong>
            <small>Upload Studio</small>
          </div>
          <Button
            variant="ghost"
            className="mobile-close"
            onClick={() => setMobile(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </Button>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              className={nav === id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setNav(id);
                setMobile(false);
              }}
            >
              <span className="nav-icon">
                <Icon size={17} />
              </span>
              <span>{label}</span>
              {id === "uploads" && counts.inflight ? (
                <em>{counts.inflight}</em>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-card">
            <DiscordAvatar access={access} />
            <div>
              <strong>{access.user?.username || "Emote Forge member"}</strong>
              <small>
                <span className="status-light good" /> Discord connected
              </small>
            </div>
          </div>
          <button className="sidebar-action" onClick={signOut}>
            <LogOut size={15} />
            <span>Sign out</span>
          </button>
          <a
            className="sidebar-action"
            href="https://emoji.gg/submit"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            <span>Open Emoji.gg</span>
          </a>
        </div>
      </aside>
      {mobile && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobile(false)}
          aria-label="Close navigation"
        />
      )}
      <main className="main-area">
        <header className="topbar">
          <Button
            variant="ghost"
            className="mobile-menu"
            onClick={() => setMobile(true)}
            aria-label="Open navigation"
          >
            <Menu size={19} />
          </Button>
          <div>
            <h1>{current[1]}</h1>
          </div>
          <div className="top-actions">
            <Button
              variant="ghost"
              onClick={refresh}
              aria-label="Refresh workspace"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </Button>
            <Button onClick={() => setImportOpen(true)}>
              <Plus size={16} /> Import pack
            </Button>
          </div>
        </header>
        {notice && (
          <div className="banner error">
            <AlertTriangle size={16} />
            <span>{notice}</span>
            <Button variant="ghost" onClick={() => setNotice("")}>
              Dismiss
            </Button>
          </div>
        )}
        <div className="content">
          {loading ? (
            <Loading />
          ) : (
            <>
              {nav === "overview" && (
                <Overview
                  assets={assets}
                  counts={counts}
                  packs={packs}
                  access={access}
                  go={setNav}
                />
              )}{" "}
              {nav === "library" && (
                <Library assets={assets} refresh={refresh} />
              )}{" "}
              {nav === "uploads" && (
                <Uploads
                  assets={assets}
                  access={access}
                  refresh={refresh}
                  setNotice={setNotice}
                />
              )}{" "}
              {nav === "stats" && (
                <Stats
                  assets={assets}
                  counts={counts}
                  packs={packs}
                  access={access}
                />
              )}{" "}
              {nav === "access" && (
                <AccessView access={access} signOut={signOut} />
              )}{" "}
              {nav === "settings" && <SettingsView access={access} />}
            </>
          )}
        </div>
      </main>
      <ImportDialog
        open={importOpen}
        close={() => setImportOpen(false)}
        after={refresh}
      />
    </div>
  );
}

function Overview({
  assets,
  counts,
  packs,
  access,
  go,
}: {
  assets: BrowserAsset[];
  counts: Record<string, number>;
  packs: number;
  access: Access;
  go: (nav: Nav) => void;
}) {
  return (
    <div className="page-grid">
      <section className="hero">
        <div>
          <Badge tone="good">Ready</Badge>
          <h2>Prepare. Queue. Upload.</h2>
          <p>
            Your files stay in this browser until they are submitted to
            Emoji.gg.
          </p>
        </div>
        <div className="hero-actions">
          <Button variant="primary" onClick={() => go("uploads")}>
            <Play size={16} /> Start upload
          </Button>
          <Button onClick={() => go("library")}>
            <BookImage size={16} /> Open library
          </Button>
        </div>
      </section>
      <section className="stat-grid">
        <Metric
          icon={Image}
          label="Assets"
          value={fmt(assets.length)}
          detail={`${packs} packs`}
        />
        <Metric
          icon={Check}
          label="Accepted"
          value={fmt(counts.submitted)}
          detail="Emoji.gg results"
        />
        <Metric
          icon={Activity}
          label="In flight"
          value={fmt(counts.inflight)}
          detail={`${fmt(counts.pending)} waiting`}
        />
        <Metric
          icon={AlertTriangle}
          label="Attention"
          value={fmt((counts.retry || 0) + (counts.uncertain || 0))}
          detail={`${fmt(counts.retry)} retry · ${fmt(counts.uncertain)} uncertain`}
        />
      </section>
      <div className="two-col">
        <Card>
          <Title eyebrow="Workflow" title="Browser-first uploads" />
          <Feature
            ok
            title="Stored locally"
            body="Images, metadata, and queue state remain on this device."
          />
          <Feature
            ok
            title="Parallel upload tabs"
            body="Only active batches are sent to signed-in Emoji.gg tabs."
          />
          <Feature
            ok={access.allowed}
            title="Discord verified"
            body={`Signed in as ${access.user?.username || "an Emote Forge member"}.`}
          />
        </Card>
        <Card>
          <Title eyebrow="Privacy" title="Your media stays yours" />
          <div className="api-boundary">
            <ShieldCheck size={21} />
            <p>
              Emote Forge verifies access, but never stores your images. Media
              goes only to Emoji.gg when you upload it.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Library({
  assets,
  refresh,
}: {
  assets: BrowserAsset[];
  refresh: () => void;
}) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = assets.filter(
    (asset) =>
      (status === "all" || asset.status === status) &&
      `${asset.title} ${asset.filename} ${asset.pack} ${asset.tags}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="stack">
      <Card className="toolbar-card">
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search assets or packs"
              aria-label="Search assets"
            />
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="retry">Retry</option>
            <option value="uncertain">Uncertain</option>
            <option value="submitted">Accepted</option>
          </select>
        </div>
      </Card>
      <Card>
        <Title eyebrow="Library" title={`${fmt(filtered.length)} assets`} />
        {filtered.length ? (
          <div className="asset-table-wrap">
            <table className="asset-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Pack</th>
                  <th>Status</th>
                  <th>Category</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((asset) => (
                  <Fragment key={asset.id}>
                  <tr
                    className={selectedId === asset.id ? "asset-row editing" : "asset-row"}
                    onClick={() => setSelectedId(selectedId === asset.id ? null : asset.id)}
                  >
                    <td>
                      <div className="asset-cell">
                        <img
                          className="preview"
                          src={URL.createObjectURL(asset.file)}
                          alt=""
                        />
                        <div>
                          <strong>{asset.title}</strong>
                          <small>{asset.filename}</small>
                        </div>
                      </div>
                    </td>
                    <td>{asset.pack}</td>
                    <td>
                      <Badge
                        tone={
                          asset.status === "submitted"
                            ? "good"
                            : asset.status === "uncertain"
                              ? "bad"
                              : asset.status === "retry"
                                ? "warn"
                                : "neutral"
                        }
                      >
                        {asset.status}
                      </Badge>
                    </td>
                    <td>{categories[Number(asset.category_value) - 1]}</td>
                    <td>
                      <Button
                        variant="ghost"
                        aria-expanded={selectedId === asset.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(selectedId === asset.id ? null : asset.id);
                        }}
                      >
                        {selectedId === asset.id ? "Close" : "Edit"}
                      </Button>
                    </td>
                  </tr>
                  {selectedId === asset.id && (
                    <tr className="asset-editor-row">
                      <td colSpan={5}>
                        <InlineAssetEditor
                          key={asset.id}
                          asset={asset}
                          close={() => setSelectedId(null)}
                          after={refresh}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Nothing here yet"
            body="Import a pack or change the filters."
          />
        )}
      </Card>
    </div>
  );
}

function Uploads({
  assets,
  access,
  refresh,
  setNotice,
}: {
  assets: BrowserAsset[];
  access: Access;
  refresh: () => void;
  setNotice: (value: string) => void;
}) {
  const [workers, setWorkerCount] = useState(3),
    [running, setRunning] = useState(false),
    [paused, setPaused] = useState(false),
    [session, setSession] = useState(""),
    [workerState, setWorkerState] = useState<Worker[]>([]);
  const workerRef = useRef<Worker[]>([]),
    queueRef = useRef<string[]>([]),
    assetsRef = useRef(assets),
    runningRef = useRef(false),
    pausedRef = useRef(false);
  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);
  useEffect(() => {
    runningRef.current = running;
    pausedRef.current = paused;
  }, [running, paused]);
  const dispatch = useCallback(
    async (workerId: string) => {
      if (!runningRef.current || pausedRef.current) return;
      const worker = workerRef.current.find((item) => item.id === workerId);
      if (!worker?.ready || worker.batchId || !worker.win || worker.win.closed)
        return;
      const ids = queueRef.current.splice(0, 10),
        batchAssets = ids
          .map((id) => assetsRef.current.find((asset) => asset.id === id))
          .filter(Boolean) as BrowserAsset[];
      if (!batchAssets.length) {
        if (workerRef.current.every((item) => !item.batchId)) {
          setRunning(false);
          runningRef.current = false;
        }
        return;
      }
      const batchId = crypto.randomUUID();
      worker.batchId = batchId;
      worker.assetIds = batchAssets.map((asset) => asset.id);
      worker.stage = `processing ${batchAssets.length}`;
      const changed = batchAssets.map((asset) => ({
        ...asset,
        status: "inflight" as const,
        updatedAt: Date.now(),
      }));
      await saveAssets(changed);
      assetsRef.current = assetsRef.current.map(
        (asset) => changed.find((item) => item.id === asset.id) || asset,
      );
      setWorkerState([...workerRef.current]);
      await refresh();
      worker.win.postMessage(
        {
          type: "EMOTE_FORGE_BATCH",
          session,
          workerId,
          batch: {
            id: batchId,
            items: batchAssets.map(({ file, ...item }) => item),
          },
          files: batchAssets.map(
            (asset) =>
              new File([asset.file], asset.filename, {
                type:
                  asset.file.type ||
                  (/\.gif$/i.test(asset.filename) ? "image/gif" : "image/png"),
              }),
          ),
        },
        "https://emoji.gg",
      );
    },
    [refresh, session],
  );
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (
        event.origin !== "https://emoji.gg" ||
        event.data?.session !== session
      )
        return;
      const worker = workerRef.current.find(
        (item) => item.id === event.data.workerId,
      );
      if (!worker || event.source !== worker.win) return;
      if (event.data.type === "EMOTE_FORGE_READY") {
        worker.ready = true;
        worker.stage = "ready";
        setWorkerState([...workerRef.current]);
        dispatch(worker.id);
      }
      if (event.data.type === "EMOTE_FORGE_HEARTBEAT") {
        worker.stage = event.data.stage || worker.stage;
        if (!event.data.active && !worker.batchId) {
          worker.ready = true;
          dispatch(worker.id);
        }
        setWorkerState([...workerRef.current]);
      }
      if (
        event.data.type === "EMOTE_FORGE_RESULT" &&
        worker.batchId === event.data.batchId
      ) {
        const batchAssets = (worker.assetIds || [])
            .map((id) => assetsRef.current.find((asset) => asset.id === id))
            .filter(Boolean) as BrowserAsset[],
          changed = batchAssets.map((asset, index) => {
            const outcome = event.data.outcomes[index] || {
                status: "uncertain",
                note: "No result returned",
              },
              attempts =
                asset.attempts + (outcome.status === "submitted" ? 0 : 1),
              status =
                outcome.status === "submitted"
                  ? "submitted"
                  : outcome.status === "retry" && attempts < 3
                    ? "retry"
                    : "uncertain";
            if (status === "retry") queueRef.current.push(asset.id);
            return {
              ...asset,
              status,
              attempts,
              note: outcome.note || "",
              updatedAt: Date.now(),
            } as BrowserAsset;
          });
        await saveAssets(changed);
        assetsRef.current = assetsRef.current.map(
          (asset) => changed.find((item) => item.id === asset.id) || asset,
        );
        worker.batchId = undefined;
        worker.assetIds = undefined;
        worker.ready = false;
        worker.stage = "refreshing form";
        setWorkerState([...workerRef.current]);
        await refresh();
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [dispatch, refresh, session]);
  const start = () => {
    if (!access.allowed) {
      setNotice(
        `Join ${access.serverName} with Discord before starting an upload.`,
      );
      return;
    }
    const candidates = assets.filter(
      (asset) => asset.status === "pending" || asset.status === "retry",
    );
    if (!candidates.length) {
      setNotice("No pending or retry assets are available.");
      return;
    }
    const nextSession = crypto.randomUUID(),
      opened: Worker[] = [];
    for (let index = 0; index < workers; index++) {
      const id = crypto.randomUUID(),
        params = new URLSearchParams({
          browser_studio_session: nextSession,
          browser_studio_worker: id,
          browser_studio_origin: location.origin,
        }),
        win = window.open(`https://emoji.gg/submit?${params}`, "_blank");
      opened.push({
        id,
        win,
        ready: false,
        stage: win ? "opening" : "popup blocked",
      });
    }
    setSession(nextSession);
    workerRef.current = opened;
    setWorkerState(opened);
    queueRef.current = candidates.map((asset) => asset.id);
    runningRef.current = true;
    setRunning(true);
    setPaused(false);
    if (opened.some((worker) => !worker.win))
      setNotice(
        "Some Emoji.gg upload tabs were blocked. Allow popups for Upload Studio and start again.",
      );
  };
  return (
    <div className="stack">
      <section className="run-hero">
        <div>
          <span className="kicker">Queue</span>
          <div className="run-title">
            <h2>
              {running ? (paused ? "Paused" : "Uploading") : "Ready to upload"}
            </h2>
            <Badge tone={running ? "info" : "neutral"}>
              {queueRef.current.length} waiting
            </Badge>
          </div>
          <p>Each worker handles batches of up to ten.</p>
        </div>
        <div className="run-actions">
          {running ? (
            <Button
              onClick={() => {
                setPaused(!paused);
                pausedRef.current = !paused;
                if (paused)
                  workerRef.current.forEach((worker) => dispatch(worker.id));
              }}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}{" "}
              {paused ? "Resume" : "Pause"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={start}
              disabled={
                !assets.some(
                  (asset) =>
                    asset.status === "pending" || asset.status === "retry",
                )
              }
            >
              <Play size={16} /> Start upload
            </Button>
          )}
        </div>
      </section>
      <section className="stat-grid">
        <Metric
          icon={Check}
          label="Accepted"
          value={fmt(
            assets.filter((asset) => asset.status === "submitted").length,
          )}
        />
        <Metric
          icon={Boxes}
          label="Waiting"
          value={fmt(
            assets.filter(
              (asset) => asset.status === "pending" || asset.status === "retry",
            ).length,
          )}
        />
        <Metric
          icon={Activity}
          label="Uploading"
          value={fmt(
            assets.filter((asset) => asset.status === "inflight").length,
          )}
        />
        <Metric
          icon={AlertTriangle}
          label="Uncertain"
          value={fmt(
            assets.filter((asset) => asset.status === "uncertain").length,
          )}
        />
      </section>
      <div className="two-col">
        <Card>
          <Title eyebrow="Upload tabs" title="Parallel uploads" />
          <label>
            Emoji.gg upload tabs
            <select
              value={workers}
              onChange={(event) => setWorkerCount(Number(event.target.value))}
            >
              {Array.from({ length: 10 }, (_, index) => (
                <option key={index + 1} value={index + 1}>
                  {index + 1} tab{index ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="muted-copy">
            Allow popups so the Studio can open the selected tabs.
          </p>
        </Card>
        <Card>
          <Title eyebrow="Recovery" title="Uncertain results" />
          <p className="muted-copy">
            Failed uploads retry automatically. Only move uncertain items back
            when you want to try them again.
          </p>
          <Button
            onClick={async () => {
              const changed = assets
                .filter((asset) => asset.status === "uncertain")
                .map((asset) => ({
                  ...asset,
                  status: "retry" as const,
                  note: "Manually returned to retry",
                  updatedAt: Date.now(),
                }));
              await saveAssets(changed);
              refresh();
            }}
            disabled={!assets.some((asset) => asset.status === "uncertain")}
          >
            <RotateCcw size={16} /> Retry uncertain
          </Button>
        </Card>
      </div>
      <Card>
        <Title
          eyebrow="Emoji.gg upload tabs"
          title={`${workerState.filter((worker) => worker.ready).length}/${workerState.length} ready`}
        />
        <div className="worker-grid">
          {workerState.length ? (
            workerState.map((worker, index) => (
              <div className="worker-card" key={worker.id}>
                <span className="worker-index">{index + 1}</span>
                <div>
                  <strong>Upload tab {index + 1}</strong>
                  <small>{worker.stage}</small>
                </div>
                <Badge
                  tone={worker.ready ? "good" : worker.win ? "neutral" : "bad"}
                >
                  {worker.ready ? "ready" : worker.stage}
                </Badge>
              </div>
            ))
          ) : (
            <Empty
              title="No upload tabs open"
              body="Choose a tab count and start the queue."
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function Stats({
  assets,
  counts,
  packs,
  access,
}: {
  assets: BrowserAsset[];
  counts: Record<string, number>;
  packs: number;
  access: Access;
}) {
  const bytes = assets.reduce((sum, asset) => sum + asset.file.size, 0),
    [profileUrl, setProfileUrl] = useState(
      localStorage.getItem("emoteForgeProfileUrl") || "",
    ),
    [profile, setProfile] = useState<any>(() => {
      try {
        return JSON.parse(localStorage.getItem("emoteForgeProfile") || "null");
      } catch {
        return null;
      }
    }),
    [syncing, setSyncing] = useState(false),
    [syncError, setSyncError] = useState("");
  const sync = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      const response = await fetch(
          `${authBase}/stats/profile?${new URLSearchParams({ url: profileUrl })}`,
          { credentials: "include" },
        ),
        payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Profile sync failed");
      setProfile(payload);
      localStorage.setItem("emoteForgeProfile", JSON.stringify(payload));
      localStorage.setItem("emoteForgeProfileUrl", payload.profileUrl);
    } catch (error) {
      setSyncError(String((error as Error).message || error));
    } finally {
      setSyncing(false);
    }
  };
  const profileCounts = profile?.counts || {};
  return (
    <div className="stack">
      <section className="stats-hero">
        <div>
          <span className="kicker">Insights</span>
          <h2>Your workspace at a glance</h2>
          <p>Emoji.gg profile totals and this browser's queue.</p>
        </div>
      </section>
      <section className="stat-grid">
        <Metric
          icon={Image}
          label="Emojis"
          value={profile ? fmt(profileCounts.emojis) : "—"}
          detail={
            profile?.observedAt
              ? `Updated ${new Date(profile.observedAt).toLocaleString()}`
              : "Sync profile"
          }
        />
        <Metric
          icon={Image}
          label="Stickers"
          value={profile ? fmt(profileCounts.stickers) : "—"}
        />
        <Metric
          icon={Boxes}
          label="Packs"
          value={profile ? fmt(profileCounts.packs) : "—"}
        />
        <Metric
          icon={Download}
          label="Downloads"
          value={profile ? fmt(profile.downloads) : "—"}
          detail={profile?.rank || ""}
        />
      </section>
      <div className="two-col">
        <Card>
          <Title
            eyebrow="Emoji.gg"
            title={profile?.username || "Profile stats"}
          />
          <div className="dialog-form">
            <label>
              Profile URL
              <input
                value={profileUrl}
                onChange={(event) => setProfileUrl(event.target.value)}
                placeholder="https://emoji.gg/user/username"
              />
            </label>
            <Button onClick={sync} disabled={!profileUrl || syncing}>
              {syncing ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <RefreshCw size={16} />
              )}{" "}
              {syncing ? "Syncing" : "Sync stats"}
            </Button>
          </div>
          {syncError && <div className="inline-notice">{syncError}</div>}
        </Card>
        <Card>
          <Title eyebrow="This browser" title="Local library" />
          <dl className="detail-list">
            <div>
              <dt>Assets</dt>
              <dd>{fmt(assets.length)}</dd>
            </div>
            <div>
              <dt>Packs</dt>
              <dd>{fmt(packs)}</dd>
            </div>
            <div>
              <dt>Media</dt>
              <dd>{(bytes / 1024 / 1024).toFixed(1)} MB</dd>
            </div>
            <div>
              <dt>Signed in</dt>
              <dd>{access.user?.username || access.state}</dd>
            </div>
          </dl>
        </Card>
      </div>
      <Card>
        <Title eyebrow="Queue" title="Submission status" />
        <div className="status-breakdown">
          {["submitted", "pending", "retry", "uncertain", "inflight"].map(
            (status) => (
              <div key={status}>
                <div>
                  <span>{status}</span>
                  <strong>{fmt(counts[status])}</strong>
                </div>
                <div className="bar">
                  <i
                    style={{
                      width: `${assets.length ? ((counts[status] || 0) / assets.length) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ),
          )}
        </div>
      </Card>
    </div>
  );
}

function AccessView({
  access,
  signOut,
}: {
  access: Access;
  signOut: () => void;
}) {
  const connect = () => {
    if (!authBase) return;
    location.href = `${authBase}/oauth/start?${new URLSearchParams({ return_to: location.origin + location.pathname }).toString()}`;
  };
  return (
    <div className="stack">
      <section className="account-hero">
        <DiscordAvatar access={access} large />
        <div>
          <Badge tone={access.allowed ? "good" : "warn"}>
            {access.allowed ? "Verified" : "Sign in required"}
          </Badge>
          <h2>
            {access.allowed
              ? access.user?.username || "Emote Forge member"
              : "Connect Discord"}
          </h2>
          <p>
            {access.allowed
              ? "Your Discord session is active."
              : "Sign in and join Emote Forge to continue."}
          </p>
        </div>
      </section>
      <div className="two-col">
        <Card>
          <Title eyebrow="Session" title="Discord access" />
          <dl className="detail-list">
            <div>
              <dt>Status</dt>
              <dd>{access.allowed ? "Verified" : "Signed out"}</dd>
            </div>
            <div>
              <dt>Member</dt>
              <dd>{access.user?.username || "—"}</dd>
            </div>
            <div>
              <dt>Session renews until</dt>
              <dd>
                {access.expiresAt
                  ? new Date(access.expiresAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
          </dl>
          {access.allowed ? (
            <Button onClick={signOut}>
              <LogOut size={16} /> Sign out
            </Button>
          ) : (
            <Button variant="primary" onClick={connect} disabled={!authBase}>
              <CircleUserRound size={16} /> Continue with Discord
            </Button>
          )}
        </Card>
        <Card>
          <Title eyebrow="Privacy" title="Discord access" />
          <Feature
            ok
            title="Membership check"
            body="Discord verifies your identity and server membership."
          />
          <Feature
            ok
            title="Local media"
            body="Images remain in your browser until upload."
          />
        </Card>
      </div>
    </div>
  );
}

function SettingsView({ access }: { access: Access }) {
  const [bridge, setBridge] = useState<
      "unknown" | "checking" | "active" | "outdated" | "inactive"
    >("unknown"),
    [bridgeVersion, setBridgeVersion] = useState("");
  const applyBridgeVersion = useCallback((version: string) => {
    setBridgeVersion(version);
    setBridge(
      !version || compareVersions(version, studioVersion) < 0
        ? "outdated"
        : "active",
    );
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.data?.type !== "EMOTE_FORGE_BRIDGE_STATUS" ||
        event.data?.source !== "userscript"
      )
        return;
      applyBridgeVersion(event.data.version || "");
    };
    addEventListener("message", receive);
    setBridge("checking");
    window.postMessage({ type: "EMOTE_FORGE_BRIDGE_PROBE" }, location.origin);
    const timer = setTimeout(
      () =>
        setBridge((current) =>
          current === "active" || current === "outdated"
            ? current
            : "inactive",
        ),
      1800,
    );
    return () => {
      clearTimeout(timer);
      removeEventListener("message", receive);
    };
  }, [applyBridgeVersion]);
  const checkBridge = () => {
    setBridge("checking");
    let answered = false;
    const directReceive = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.data?.type !== "EMOTE_FORGE_BRIDGE_STATUS" ||
        event.data?.source !== "userscript"
      )
        return;
      answered = true;
      removeEventListener("message", directReceive);
      applyBridgeVersion(event.data.version || "");
    };
    addEventListener("message", directReceive);
    window.postMessage({ type: "EMOTE_FORGE_BRIDGE_PROBE" }, location.origin);
    const session = crypto.randomUUID(),
      origin = location.origin;
    setTimeout(() => {
      removeEventListener("message", directReceive);
      if (answered) return;
      const popup = window.open(
        `https://emoji.gg/submit?${new URLSearchParams({ browser_studio_probe: session, browser_studio_origin: origin })}`,
        "_blank",
      );
      const timer = setTimeout(() => setBridge("inactive"), 8000);
      const receive = (event: MessageEvent) => {
        if (
          event.origin !== "https://emoji.gg" ||
          event.data?.type !== "EMOTE_FORGE_BRIDGE_STATUS" ||
          event.data?.session !== session
        )
          return;
        clearTimeout(timer);
        removeEventListener("message", receive);
        applyBridgeVersion(event.data.version || "");
        setTimeout(() => popup?.close(), 350);
      };
      addEventListener("message", receive);
    }, 350);
  };
  const state = {
      unknown: { tone: "neutral" as const, icon: Plug, label: "Not checked" },
      checking: {
        tone: "info" as const,
        icon: LoaderCircle,
        label: "Checking…",
      },
      active: {
        tone: "good" as const,
        icon: Wifi,
        label: `Up to date · v${bridgeVersion}`,
      },
      outdated: {
        tone: "warn" as const,
        icon: AlertTriangle,
        label: `Update required${bridgeVersion ? ` · v${bridgeVersion}` : ""}`,
      },
      inactive: { tone: "bad" as const, icon: WifiOff, label: "Not detected" },
    }[bridge],
    BridgeIcon = state.icon;
  return (
    <div className="stack">
      <section className="setup-hero">
        <div>
          <span className="kicker">Setup</span>
          <h2>Connect the Emoji.gg bridge</h2>
          <p>
            The Tampermonkey userscript fills and submits Emoji.gg upload forms
            for this Studio.
          </p>
        </div>
        <div className={`bridge-state ${bridge}`}>
          <BridgeIcon
            className={bridge === "checking" ? "spin" : ""}
            size={18}
          />
          <div>
            <small>Userscript</small>
            <strong>{state.label}</strong>
          </div>
        </div>
      </section>
      <div className="two-col">
        <Card>
          <Title
            eyebrow="Required"
            title={bridge === "outdated" ? "Update the userscript" : "Install the userscript"}
          />
          <ol className="setup-steps">
            <li>Install the Tampermonkey browser extension.</li>
            <li>
              Click <strong>{bridge === "outdated" ? "Update from Studio" : "Install userscript"}</strong> and confirm the {bridge === "outdated" ? "replacement" : "script"} in Tampermonkey. You can also update through Greasy Fork.
            </li>
            <li>
              Return here, reload this page, then click <strong>Check connection</strong>.
            </li>
          </ol>
          <div className="settings-actions">
            <a
              className="button button-primary"
              href={bridge === "outdated" ? "./uploader.user.js" : userscriptInstallUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={16} /> {bridge === "outdated" ? "Update from Studio" : "Install userscript"}
            </a>
            {bridge === "outdated" && (
              <a
                className="button button-ghost"
                href={userscriptInstallUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} /> Update through Greasy Fork
              </a>
            )}
            <Button onClick={checkBridge} disabled={bridge === "checking"}>
              <RefreshCw size={16} /> Check connection
            </Button>
          </div>
          {bridge === "inactive" && (
            <div className="inline-notice">
              The bridge did not answer. Confirm Tampermonkey is enabled for
              emoji.gg, then check again.
            </div>
          )}
          {bridge === "outdated" && (
            <div className="inline-notice warning">
              The installed userscript is v{bridgeVersion || "unknown"}. Upload Studio v{studioVersion} requires userscript v{studioVersion}; these separate components must use matching versions before uploading.
            </div>
          )}
        </Card>
        <Card>
          <Title eyebrow="Studio" title="Workspace" />
          <dl className="settings-list">
            <div>
              <dt>Upload Studio version</dt>
              <dd>
                <code>{studioVersion}</code>
              </dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd>This browser</dd>
            </div>
            <div>
              <dt>Media hosting</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Discord</dt>
              <dd>{access.user?.username || "Signed out"}</dd>
            </div>
          </dl>
          <div className="settings-actions">
            <a
              className="button button-ghost"
              href="./upload_manifest.template.csv"
              download
            >
              <FileSpreadsheet size={16} /> CSV template
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ImportDialog({
  open,
  close,
  after,
}: {
  open: boolean;
  close: () => void;
  after: () => void;
}) {
  const [pack, setPack] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [csv, setCsv] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const run = async () => {
    setBusy(true);
    try {
      const rows = csv ? parseCsv(await csv.text()) : [],
        byName = new Map(
          rows.map((row) => [String(row.filename || "").toLowerCase(), row]),
        ),
        safePack = pack
          .trim()
          .replace(/[^a-z0-9 _-]/gi, "")
          .slice(0, 80);
      if (!safePack) throw new Error("Enter a pack name");
      if (!files.length) throw new Error("Select PNG or GIF images");
      const assets = files.map((file) =>
        makeAsset(safePack, file, byName.get(file.name.toLowerCase())),
      );
      const titleGroups = new Map<string, BrowserAsset[]>();
      for (const asset of assets) {
        const key = asset.title.toLowerCase();
        titleGroups.set(key, [...(titleGroups.get(key) || []), asset]);
      }
      for (const group of titleGroups.values()) {
        if (group.length < 2) continue;
        group.forEach((asset, index) => {
          const identity =
            asset.filename.match(/^\d+/)?.[0] || String(index + 1);
          asset.title = `${asset.title} ${identity}`.slice(0, 100);
        });
      }
      await saveAssets(assets);
      setPack("");
      setFiles([]);
      setCsv(null);
      close();
      after();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && close()}
      title="Import a prepared pack"
      description="Select up to 500 PNG or GIF files. They remain in this browser's IndexedDB."
    >
      <div className="dialog-form">
        <label>
          Pack name
          <input
            value={pack}
            onChange={(event) => setPack(event.target.value)}
            placeholder="Example: winter-reactions"
          />
        </label>
        <label>
          Metadata CSV <small>optional</small>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setCsv(event.target.files?.[0] || null)}
          />
        </label>
        <label>
          PNG or GIF images
          <input
            type="file"
            accept=".png,.gif,image/png,image/gif"
            multiple
            onChange={(event) =>
              setFiles([...(event.target.files || [])].slice(0, 500))
            }
          />
        </label>
        <div className="inline-notice">
          {files.length
            ? `${files.length} images selected`
            : "Starter metadata will be generated from filenames."}
        </div>
        {notice && <div className="inline-notice">{notice}</div>}
        <div className="dialog-actions">
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Upload size={16} />
            )}{" "}
            Import pack
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function InlineAssetEditor({
  asset,
  close,
  after,
}: {
  asset: BrowserAsset;
  close: () => void;
  after: () => void;
}) {
  const [draft, setDraft] = useState<BrowserAsset>(asset),
    [busy, setBusy] = useState<"save" | "delete" | "">(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    setDraft(asset);
    setBusy("");
    setNotice("");
  }, [asset.id]);
  const set = (key: keyof BrowserAsset, value: string) =>
    setDraft({ ...draft, [key]: value });
  return (
    <div className="inline-editor-shell">
      <div className="inline-editor-head">
        <div><strong>{draft.filename}</strong><small>{draft.pack} · {draft.status}</small></div>
        <Button variant="ghost" onClick={close} aria-label="Close editor"><X size={16} /></Button>
      </div>
      <div className="editor-layout inline-editor-layout">
        <img
          className="preview large"
          src={URL.createObjectURL(draft.file)}
          alt=""
        />
        <div className="dialog-form">
          <label>
            Name
            <input
              value={draft.title}
              onChange={(event) => set("title", sanitizeEmojiName(event.target.value))}
              onBlur={() => set("title", draft.title.trim())}
              pattern="[A-Za-z0-9 ]+"
              title="Use letters, numbers, and spaces only"
            />
            <small>Letters, numbers, and spaces only.</small>
          </label>
          <label>
            Prioritized tags
            <input
              value={draft.tags}
              onChange={(event) => set("tags", event.target.value)}
            />
          </label>
          <div className="form-grid two">
            <label>
              Category
              <select
                value={draft.category_value}
                onChange={(event) => set("category_value", event.target.value)}
              >
                {categories.map((category, index) => (
                  <option value={index + 1} key={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              License
              <select
                value={draft.license}
                onChange={(event) => set("license", event.target.value)}
              >
                {licenses.map((license) => (
                  <option key={license}>{license}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Description
            <textarea
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
            <small>{draft.description.length}/2500</small>
          </label>
          {notice && <div className={notice === "Changes saved." ? "inline-notice good" : "inline-notice"}>{notice}</div>}
          <div className="dialog-actions split">
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(`Delete ${draft.filename} from this browser library?`)) return;
                setBusy("delete");
                setNotice("");
                try {
                  await removeAsset(draft.id);
                  close();
                  after();
                } catch (error) {
                  setNotice((error as Error).message);
                  setBusy("");
                }
              }}
              disabled={Boolean(busy)}
            >
              {busy === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} Delete
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                setBusy("save");
                setNotice("");
                try {
                  const normalized = sanitizeEmojiName(draft.title).trim();
                  if (!normalized) throw new Error("Name must contain at least one letter or number.");
                  const next = { ...draft, title: normalized };
                  setDraft(next);
                  await saveAsset(next);
                  after();
                  setNotice("Changes saved.");
                } catch (error) {
                  setNotice((error as Error).message);
                } finally {
                  setBusy("");
                }
              }}
              disabled={Boolean(busy)}
            >
              {busy === "save" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessGate({ access }: { access: Access }) {
  const connect = () => {
    location.href = `${authBase}/oauth/start?${new URLSearchParams({ return_to: location.origin + location.pathname }).toString()}`;
  };
  return (
    <main className="access-gate">
      <section className="access-panel">
        <span className="brand-mark">
          <Upload size={21} />
        </span>
        <div>
          <span className="kicker">Emote Forge</span>
          <h1>
            {access.state === "checking" ? "Checking access…" : "Welcome back"}
          </h1>
          <p>Sign in with Discord to open your Upload Studio.</p>
        </div>
        {access.state === "checking" ? (
          <LoaderCircle className="spin" size={24} />
        ) : (
          <Button variant="primary" onClick={connect}>
            <CircleUserRound size={17} /> Continue with Discord
          </Button>
        )}
        <small>Membership is required. Your media stays in your browser.</small>
      </section>
    </main>
  );
}
function Title({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="section-title">
      <div>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: any;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">
        <Icon size={19} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}
function Feature({
  ok = false,
  title,
  body,
}: {
  ok?: boolean;
  title: string;
  body: string;
}) {
  return (
    <div className="feature">
      <span className={ok ? "feature-icon good" : "feature-icon"}>
        {ok ? <Check size={15} /> : <ShieldCheck size={15} />}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}
function DiscordAvatar({
  access,
  large = false,
}: {
  access: Access;
  large?: boolean;
}) {
  const avatar = access.user?.avatar,
    src =
      avatar && access.user?.id
        ? `https://cdn.discordapp.com/avatars/${access.user.id}/${avatar}.png?size=128`
        : "";
  return src ? (
    <img
      className={large ? "discord-avatar large" : "discord-avatar"}
      src={src}
      alt=""
    />
  ) : (
    <span
      className={
        large
          ? "discord-avatar placeholder large"
          : "discord-avatar placeholder"
      }
    >
      <CircleUserRound size={large ? 32 : 20} />
    </span>
  );
}
function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={20} /> Loading workspace…
    </div>
  );
}
