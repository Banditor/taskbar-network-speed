(function () {
  const STORAGE_KEY = "treasure-monitor-config-v1";
  const POLL_MS = 10000;
  const ISSUE_POLL_MS = 30000;

  const el = {
    owner: document.getElementById("owner"),
    repo: document.getElementById("repo"),
    branch: document.getElementById("branch"),
    workflow: document.getElementById("workflow"),
    token: document.getElementById("token"),
    saveBtn: document.getElementById("saveBtn"),
    notifyBtn: document.getElementById("notifyBtn"),
    runBtn: document.getElementById("runBtn"),
    monitorBtn: document.getElementById("monitorBtn"),
    advancedToggle: document.getElementById("advancedToggle"),
    advancedPanel: document.getElementById("advancedPanel"),
    statusMsg: document.getElementById("statusMsg"),
    runsBody: document.getElementById("runsBody"),
    hitPanel: document.getElementById("hitPanel")
  };

  const DEFAULT_CONFIG = {
    owner: "Banditor",
    repo: "pc-help-gifts",
    branch: "main",
    workflow: "treasure-monitor.yml",
    token: ""
  };

  const state = {
    monitorOn: false,
    monitorTimer: null,
    issueTimer: null,
    lastNotifiedIssueId: null,
    currentRunId: null,
    currentRunNumber: null
  };

  function getConfig() {
    return {
      owner: (el.owner.value || DEFAULT_CONFIG.owner).trim(),
      repo: (el.repo.value || DEFAULT_CONFIG.repo).trim(),
      branch: (el.branch.value || DEFAULT_CONFIG.branch).trim(),
      workflow: (el.workflow.value || DEFAULT_CONFIG.workflow).trim(),
      token: (el.token.value || "").trim()
    };
  }

  function setStatus(text, kind) {
    el.statusMsg.textContent = text;
    el.statusMsg.className = `message${kind ? ` ${kind}` : ""}`;
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const cfg = raw ? JSON.parse(raw) : {};
      el.owner.value = cfg.owner || DEFAULT_CONFIG.owner;
      el.repo.value = cfg.repo || DEFAULT_CONFIG.repo;
      el.branch.value = cfg.branch || DEFAULT_CONFIG.branch;
      el.workflow.value = cfg.workflow || DEFAULT_CONFIG.workflow;
      el.token.value = cfg.token || "";
    } catch (_) {
      el.owner.value = DEFAULT_CONFIG.owner;
      el.repo.value = DEFAULT_CONFIG.repo;
      el.branch.value = DEFAULT_CONFIG.branch;
      el.workflow.value = DEFAULT_CONFIG.workflow;
    }
  }

  function saveConfig() {
    const cfg = getConfig();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    setStatus("הטוקן וההגדרות נשמרו על המכשיר הזה.", "success");
  }

  function requireConfig() {
    const cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.workflow || !cfg.branch || !cfg.token) {
      throw new Error("חסרים פרטי owner/repo/workflow/branch/token");
    }
    return cfg;
  }

  async function gh(path, options = {}) {
    const cfg = requireConfig();
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    };

    const response = await fetch(`https://api.github.com${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      let details = "";
      try {
        const payload = await response.json();
        details = payload.message || JSON.stringify(payload);
      } catch (_) {
        details = await response.text();
      }
      throw new Error(`GitHub API ${response.status}: ${details}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function rowHtml(run) {
    const status = run.status === "completed" ? run.conclusion || "completed" : run.status;
    return `
      <tr>
        <td>${run.run_number || "-"}</td>
        <td>${status || "-"}</td>
        <td>${run.display_title || run.name || "-"}</td>
        <td>${new Date(run.updated_at).toLocaleString("he-IL")}</td>
        <td><a class="btn btn-secondary" target="_blank" rel="noopener" href="${run.html_url}">פתח</a></td>
      </tr>
    `;
  }

  function renderRuns(runs) {
    if (!Array.isArray(runs) || runs.length === 0) {
      el.runsBody.innerHTML = '<tr><td colspan="5" class="muted">אין ריצות להצגה</td></tr>';
      return;
    }
    el.runsBody.innerHTML = runs.slice(0, 8).map(rowHtml).join("");
  }

  function extractLinksFromIssue(issue) {
    const links = [];
    const body = String(issue?.body || "");
    const regex = /https?:\/\/[^\s)]+/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
      links.push(match[0]);
    }
    return [...new Set(links)];
  }

  function parseIssueRunNumber(issueTitle) {
    const m = String(issueTitle || "").match(/run\s*#(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  function notify(title, body, url) {
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      if (url) window.open(url, "_blank", "noopener");
    };
  }

  function renderHit(issue, links) {
    const firstLink = links[0] || "";
    const items = links.length
      ? links.map((l) => `<li><a target="_blank" rel="noopener" href="${l}">${l}</a></li>`).join("")
      : '<li class="muted">לא נמצאו קישורים בגוף ה-issue</li>';

    el.hitPanel.innerHTML = `
      <div class="actions" style="margin-bottom:10px;">
        <a class="btn btn-danger" target="_blank" rel="noopener" href="${issue.html_url}">פתח Issue</a>
        ${firstLink ? `<a class="btn btn-ok" target="_blank" rel="noopener" href="${firstLink}">פתח קישור מתנה</a>` : ""}
      </div>
      <div><strong>Issue:</strong> ${issue.title}</div>
      <div class="muted">עודכן: ${new Date(issue.updated_at).toLocaleString("he-IL")}</div>
      <ul>${items}</ul>
    `;
  }

  async function listWorkflowRuns() {
    const cfg = requireConfig();
    const res = await gh(`/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/runs?branch=${encodeURIComponent(cfg.branch)}&per_page=10`);
    const runs = res?.workflow_runs || [];
    renderRuns(runs);
    return runs;
  }

  async function listTreasureIssues() {
    const cfg = requireConfig();
    const q = encodeURIComponent(`repo:${cfg.owner}/${cfg.repo} label:treasure-alert is:issue`);
    const res = await gh(`/search/issues?q=${q}&sort=created&order=desc&per_page=10`);
    return res?.items || [];
  }

  async function runNow() {
    const cfg = requireConfig();
    setStatus("שולח בקשת Run workflow...", "");

    await gh(`/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`, {
      method: "POST",
      body: { ref: cfg.branch }
    });

    setStatus("הופעל. מחפש את הריצה החדשה...", "success");

    const before = Date.now() - 20000;
    let targetRun = null;
    for (let i = 0; i < 18; i += 1) {
      const runs = await listWorkflowRuns();
      targetRun = runs.find((r) => new Date(r.created_at).getTime() >= before);
      if (targetRun) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (!targetRun) {
      setStatus("לא אותרה ריצה חדשה עדיין. רענן בעוד כמה שניות.", "error");
      return;
    }

    state.currentRunId = targetRun.id;
    state.currentRunNumber = targetRun.run_number;
    setStatus(`הריצה #${targetRun.run_number} התחילה. עוקב...`, "success");
    await watchCurrentRun();
  }

  async function watchCurrentRun() {
    if (!state.currentRunId) return;
    const cfg = requireConfig();

    for (let i = 0; i < 120; i += 1) {
      const run = await gh(`/repos/${cfg.owner}/${cfg.repo}/actions/runs/${state.currentRunId}`);
      await listWorkflowRuns();

      if (run.status === "completed") {
        if (run.conclusion === "failure") {
          setStatus(`HIT זוהה בריצה #${run.run_number}. מחפש issue...`, "error");
          await handlePotentialHit(run.run_number);
          return;
        }

        setStatus(`הריצה הסתיימה: ${run.conclusion || "completed"}`, "success");
        return;
      }

      setStatus(`ריצה #${run.run_number} עדיין: ${run.status}`, "");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    setStatus("נגמר זמן המתנה לריצה. אפשר לבדוק ב-Actions ידנית.", "error");
  }

  async function handlePotentialHit(runNumber) {
    for (let i = 0; i < 24; i += 1) {
      const issues = await listTreasureIssues();
      const matched = issues.find((issue) => parseIssueRunNumber(issue.title) === runNumber)
        || issues[0];

      if (matched) {
        const links = extractLinksFromIssue(matched);
        renderHit(matched, links);

        if (state.lastNotifiedIssueId !== matched.id) {
          state.lastNotifiedIssueId = matched.id;
          const first = links[0] || matched.html_url;
          notify("Treasure HIT", matched.title, first);
        }

        setStatus("HIT נמצא. הקישור מוצג למטה.", "error");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    setStatus("נראה שהיה HIT אבל עדיין אין Issue. בדוק את Actions/Artifacts.", "error");
  }

  async function pollIssuesLoop() {
    if (!state.monitorOn) return;

    try {
      const issues = await listTreasureIssues();
      const latest = issues[0];
      if (latest) {
        const links = extractLinksFromIssue(latest);
        renderHit(latest, links);

        if (state.lastNotifiedIssueId !== latest.id) {
          state.lastNotifiedIssueId = latest.id;
          const first = links[0] || latest.html_url;
          notify("Treasure Alert", latest.title, first);
          setStatus("זוהה HIT חדש מהניטור הרציף.", "error");
        }
      }
    } catch (error) {
      setStatus(String(error.message || error), "error");
    } finally {
      if (state.monitorOn) {
        state.issueTimer = setTimeout(pollIssuesLoop, ISSUE_POLL_MS);
      }
    }
  }

  function toggleMonitor() {
    state.monitorOn = !state.monitorOn;
    if (state.monitorOn) {
      el.monitorBtn.textContent = "עצור ניטור";
      pollIssuesLoop();
      setStatus("ניטור רציף פעיל.", "success");
    } else {
      el.monitorBtn.textContent = "ניטור רציף";
      if (state.issueTimer) clearTimeout(state.issueTimer);
      setStatus("ניטור רציף נעצר.", "");
    }
  }

  function toggleAdvancedPanel() {
    const isHidden = el.advancedPanel.classList.contains("hidden");
    el.advancedPanel.classList.toggle("hidden", !isHidden);
    el.advancedToggle.textContent = isHidden ? "הסתר הגדרות מתקדמות" : "הגדרות מתקדמות";
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      setStatus("הדפדפן לא תומך בהתראות.", "error");
      return;
    }

    const result = await Notification.requestPermission();
    if (result === "granted") {
      setStatus("התראות הופעלו בהצלחה.", "success");
      notify("Treasure Monitor", "ההתראות פעילות", "");
      return;
    }

    setStatus("הרשאת התראות לא אושרה.", "error");
  }

  async function refreshRuns() {
    try {
      await listWorkflowRuns();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  }

  el.saveBtn.addEventListener("click", saveConfig);
  el.notifyBtn.addEventListener("click", requestNotificationPermission);
  el.runBtn.addEventListener("click", async () => {
    try {
      saveConfig();
      await runNow();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });
  el.monitorBtn.addEventListener("click", () => {
    try {
      saveConfig();
      toggleMonitor();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });
  el.advancedToggle.addEventListener("click", toggleAdvancedPanel);

  loadConfig();
  refreshRuns();
  state.monitorTimer = setInterval(refreshRuns, 20000);
})();
