(async () => {
  const config = window.CLOUD_CONFIG || {};
  const api = new window.CloudApi(config);
  let workspace = null;
  let state = { students: [], records: [] };
  let currentView = "dashboard";
  let searchText = "";
  let studentSubject = "全部";
  let studentPage = 1;
  let paymentPage = 1;
  let reviewPage = 1;
  let lastVersion = "";
  let syncTimer = null;
  const PAGE_SIZE = 20;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (value) => value == null ? "—" : `¥${Number(value).toLocaleString("zh-CN")}`;
  const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const initials = (name) => name.replace(/\s+/g, "").slice(0, 1).toUpperCase() || "学";

  function mapStudent(row) {
    return {
      id: row.id,
      legacyId: row.legacy_id,
      name: row.name,
      subject: row.subject,
      status: row.status,
      phone: row.phone || "",
      guardian: row.guardian || "",
      note: row.note || "",
      sourceRow: row.source_row,
      originalSequence: row.original_sequence || "",
      duplicateName: Boolean(row.duplicate_name),
      imported: Boolean(row.imported),
    };
  }

  function mapRecord(row) {
    return {
      id: row.id,
      legacyId: row.legacy_id,
      studentId: row.student_id,
      studentName: row.student_name,
      subject: row.subject,
      term: row.term,
      amount: row.amount == null ? null : Number(row.amount),
      paymentDate: row.payment_date || "",
      method: row.method,
      kind: row.kind,
      status: row.status,
      note: row.note || "",
      source: row.source || "系统新增",
      imported: Boolean(row.imported),
      createdAt: row.created_at,
    };
  }

  function setAuthMessage(message, success = false) {
    const host = $("#authMessage");
    host.textContent = message;
    host.style.color = success ? "var(--green)" : "var(--rose)";
  }

  function setLoading(show, message = "正在同步云端数据…") {
    $("#loadingScreen").classList.toggle("hidden", !show);
    $("#loadingScreen strong").textContent = message;
  }

  function setSyncStatus(message, syncing = false) {
    const status = $("#syncStatus");
    status.textContent = syncing ? `◌ ${message}` : `● ${message}`;
    status.classList.toggle("syncing", syncing);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  async function startApp() {
    setLoading(true);
    $("#authScreen").classList.add("hidden");
    try {
      workspace = await api.getOrCreateWorkspace();
      await loadCloudState();
      $("#accountEmail").textContent = api.session?.user?.email || "云端账号";
      $("#appShell").classList.remove("hidden");
      setLoading(false);
      render();
      startSyncMonitor();
    } catch (error) {
      setLoading(false);
      $("#authScreen").classList.remove("hidden");
      setAuthMessage(`连接失败：${error.message}`);
    }
  }

  async function loadCloudState(silent = false) {
    if (!silent) setSyncStatus("正在同步", true);
    const data = await api.loadData(workspace.id);
    state = {
      students: data.students.map(mapStudent),
      records: data.records.map(mapRecord),
    };
    lastVersion = await api.workspaceVersion(workspace.id);
    setSyncStatus(`已同步 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
  }

  async function syncNow(showMessage = true) {
    try {
      setSyncStatus("正在同步", true);
      await loadCloudState(true);
      render();
      if (showMessage) showToast("云端数据已同步");
    } catch (error) {
      setSyncStatus("同步失败", true);
      if (showMessage) showToast(error.message);
    }
  }

  function startSyncMonitor() {
    clearInterval(syncTimer);
    syncTimer = setInterval(async () => {
      if (document.hidden || !workspace) return;
      try {
        const version = await api.workspaceVersion(workspace.id);
        if (version && version !== lastVersion) await syncNow(false);
      } catch (_) {
        setSyncStatus("等待网络", true);
      }
    }, 15000);
  }

  function recordsFor(studentId) {
    return state.records.filter((record) => record.studentId === studentId);
  }

  function visibleBySearch(record) {
    if (!searchText) return true;
    const haystack = [record.studentName, record.name, record.subject, record.term, record.note, record.source].join(" ").toLowerCase();
    return haystack.includes(searchText);
  }

  function navigate(view) {
    currentView = view;
    $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    $("#pageTitle").textContent = ({ dashboard: "缴费总览", students: "学员档案", payments: "缴费记录", review: "待核对清单" })[view];
    render();
  }

  function render() {
    const reviewCount = state.records.filter((record) => record.status === "待核对").length;
    $("#reviewBadge").textContent = reviewCount;
    if (currentView === "dashboard") renderDashboard();
    if (currentView === "students") renderStudents();
    if (currentView === "payments") renderPayments();
    if (currentView === "review") renderReview();
  }

  function renderDashboard() {
    const numeric = state.records.filter((record) => record.amount != null);
    const total = numeric.reduce((sum, record) => sum + Number(record.amount), 0);
    const review = state.records.filter((record) => record.status === "待核对");
    $("#importSummary").textContent = `${state.students.length} 位学员、${state.records.length} 条记录；手机和电脑使用同一云端数据。`;
    $("#metricStudents").textContent = state.students.length.toLocaleString("zh-CN");
    $("#metricAmount").textContent = money(total);
    $("#metricRecords").textContent = state.records.length.toLocaleString("zh-CN");
    $("#metricReview").textContent = review.length.toLocaleString("zh-CN");

    const termTotals = new Map();
    numeric.forEach((record) => termTotals.set(record.term, (termTotals.get(record.term) || 0) + Number(record.amount)));
    const rank = (term) => {
      const match = term.match(/(\d{2})/);
      const year = match ? Number(match[1]) : 0;
      const season = term.includes("暑") ? 4 : term.includes("春") ? 3 : term.includes("寒") ? 2 : term.includes("秋") ? 1 : 0;
      return year * 10 + season;
    };
    const topTerms = [...termTotals.entries()].sort((a, b) => rank(b[0]) - rank(a[0])).slice(0, 9);
    const max = Math.max(...topTerms.map(([, value]) => value), 1);
    $("#termChart").innerHTML = topTerms.map(([term, value]) => `
      <div class="bar-item" title="${escapeHtml(term)}：${money(value)}">
        <div class="bar-amount">${value >= 10000 ? `${Math.round(value / 10000)}万` : money(value)}</div>
        <div class="bar" style="height:${Math.max(8, Math.round(value / max * 185))}px"></div>
        <div class="bar-label">${escapeHtml(term)}</div>
      </div>`).join("") || `<div class="empty">导入数据后显示学期收款统计</div>`;
    $("#recentPayments").innerHTML = [...state.records].reverse().slice(0, 6).map((record) => `
      <div class="recent-item"><span class="avatar">${escapeHtml(initials(record.studentName))}</span>
        <div><strong>${escapeHtml(record.studentName)}</strong><small>${escapeHtml(record.term)} · ${escapeHtml(record.method)}</small></div>
        <span class="money">${money(record.amount)}</span></div>`).join("") || `<div class="empty">暂时没有缴费记录</div>`;
    $("#priorityReview").innerHTML = review.slice(0, 3).map((record) => `
      <button class="mini-review row-action" data-edit-record="${record.id}">
        <strong>${escapeHtml(record.studentName)} · ${escapeHtml(record.term)}</strong><p>${escapeHtml(record.note)}</p>
      </button>`).join("") || `<div class="empty">太漂亮了，暂时没有待核对内容。</div>`;
  }

  function renderStudents() {
    let students = state.students.filter((student) => studentSubject === "全部" || student.subject === studentSubject);
    students = students.filter(visibleBySearch);
    const totalPages = Math.max(1, Math.ceil(students.length / PAGE_SIZE));
    studentPage = Math.min(studentPage, totalPages);
    const pageRows = students.slice((studentPage - 1) * PAGE_SIZE, studentPage * PAGE_SIZE);
    $("#studentCountLabel").textContent = `共 ${students.length} 位学员`;
    $("#studentTableBody").innerHTML = pageRows.map((student) => {
      const records = recordsFor(student.id);
      const total = records.reduce((sum, record) => sum + (Number(record.amount) || 0), 0);
      const review = records.filter((record) => record.status === "待核对").length;
      return `<tr>
        <td><div class="person"><span class="avatar">${escapeHtml(initials(student.name))}</span><div><strong>${escapeHtml(student.name)}</strong><small>${student.duplicateName ? "同名记录 · " : ""}${student.sourceRow ? `原表第 ${student.sourceRow} 行` : "系统新增"}</small></div></div></td>
        <td><span class="tag ${student.subject === "英语" ? "english" : ""}">${escapeHtml(student.subject)}</span></td>
        <td><span class="tag">${escapeHtml(student.status)}</span></td><td>${records.length}</td><td class="money">${money(total)}</td>
        <td><span class="tag ${review ? "review" : "confirmed"}">${review ? `${review} 条` : "已清"}</span></td>
        <td><button class="row-action" data-student="${student.id}">查看档案 →</button></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">没有匹配的学员</td></tr>`;
    renderPagination("#studentPagination", studentPage, totalPages, (page) => { studentPage = page; renderStudents(); });
  }

  function paymentFilters() {
    return {
      subject: $("#paymentSubjectFilter")?.value || "全部科目",
      term: $("#paymentTermFilter")?.value || "全部学期",
      status: $("#paymentStatusFilter")?.value || "全部状态",
    };
  }

  function filteredPayments() {
    const filters = paymentFilters();
    return state.records.filter((record) =>
      (filters.subject === "全部科目" || record.subject === filters.subject) &&
      (filters.term === "全部学期" || record.term === filters.term) &&
      (filters.status === "全部状态" || record.status === filters.status) &&
      visibleBySearch(record)
    );
  }

  function renderPayments() {
    const termSelect = $("#paymentTermFilter");
    const selectedTerm = termSelect.value;
    termSelect.innerHTML = `<option>全部学期</option>`;
    [...new Set(state.records.map((record) => record.term))].filter(Boolean).sort().reverse().forEach((term) => termSelect.add(new Option(term, term)));
    if ([...termSelect.options].some((option) => option.value === selectedTerm)) termSelect.value = selectedTerm;
    const records = filteredPayments();
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    paymentPage = Math.min(paymentPage, totalPages);
    $("#paymentCountLabel").textContent = `共 ${records.length} 条记录`;
    $("#paymentTableBody").innerHTML = records.slice((paymentPage - 1) * PAGE_SIZE, paymentPage * PAGE_SIZE).map((record) => `
      <tr>
        <td><div class="person"><span class="avatar">${escapeHtml(initials(record.studentName))}</span><strong>${escapeHtml(record.studentName)}</strong></div></td>
        <td><span class="tag ${record.subject === "英语" ? "english" : ""}">${escapeHtml(record.subject)}</span></td>
        <td>${escapeHtml(record.term)}</td><td class="money">${money(record.amount)}</td><td>${escapeHtml(record.method)}</td>
        <td><span class="tag ${record.status === "已确认" ? "confirmed" : "review"}">${escapeHtml(record.status)}</span></td>
        <td class="raw-cell" title="${escapeHtml(record.note)}">${escapeHtml(record.note)}</td>
        <td><button class="row-action" data-edit-record="${record.id}">编辑</button></td></tr>`).join("") || `<tr><td colspan="8" class="empty">没有匹配的缴费记录</td></tr>`;
    renderPagination("#paymentPagination", paymentPage, totalPages, (page) => { paymentPage = page; renderPayments(); });
  }

  function renderReview() {
    const kind = $("#reviewKindFilter").value;
    const records = state.records.filter((record) => record.status === "待核对" && (kind === "全部" || record.kind === kind) && visibleBySearch(record));
    const totalPages = Math.max(1, Math.ceil(records.length / 12));
    reviewPage = Math.min(reviewPage, totalPages);
    const confirmed = state.records.filter((record) => record.status === "已确认").length;
    $("#reviewProgress").textContent = `${Math.round(confirmed / Math.max(state.records.length, 1) * 100)}%`;
    $("#reviewCountLabel").textContent = `剩余 ${records.length} 条`;
    $("#reviewList").innerHTML = records.slice((reviewPage - 1) * 12, reviewPage * 12).map((record) => `
      <article class="review-card">
        <div><strong>${escapeHtml(record.studentName)}</strong><div class="source">${escapeHtml(record.subject)} · ${escapeHtml(record.term)} · ${escapeHtml(record.source)}</div></div>
        <div class="raw">${escapeHtml(record.note)}</div>
        <div><span class="tag review">${kindLabel(record.kind)}</span><br><span class="money">${money(record.amount)}</span></div>
        <div class="actions"><button class="secondary compact" data-edit-record="${record.id}">编辑</button><button class="primary compact" data-confirm="${record.id}">确认无误</button></div>
      </article>`).join("") || `<article class="panel empty">这一类已经全部核对完成。</article>`;
    renderPagination("#reviewPagination", reviewPage, totalPages, (page) => { reviewPage = page; renderReview(); });
  }

  function kindLabel(kind) {
    return ({ payment: "复杂金额", status: "状态记录", lessons: "课时记录", note: "其他备注" })[kind] || "记录";
  }

  function renderPagination(selector, page, totalPages, onChange) {
    const host = $(selector);
    host.innerHTML = "";
    if (totalPages <= 1) return;
    const pages = [...new Set([1, page - 1, page, page + 1, totalPages].filter((value) => value >= 1 && value <= totalPages))];
    pages.forEach((value, index) => {
      if (index && value - pages[index - 1] > 1) host.insertAdjacentHTML("beforeend", "<span>…</span>");
      const button = document.createElement("button");
      button.textContent = value;
      button.classList.toggle("active", value === page);
      button.onclick = () => onChange(value);
      host.appendChild(button);
    });
  }

  function openStudent(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return;
    const records = recordsFor(studentId);
    const total = records.reduce((sum, record) => sum + (Number(record.amount) || 0), 0);
    $("#studentDrawerContent").innerHTML = `
      <div class="student-hero"><span class="avatar">${escapeHtml(initials(student.name))}</span><h2>${escapeHtml(student.name)}</h2><p>${escapeHtml(student.subject)} · ${escapeHtml(student.status)} · ${student.sourceRow ? `来源：原表第 ${student.sourceRow} 行` : "系统新增"}</p></div>
      <div class="student-summary"><div><small>记录数</small><strong>${records.length}</strong></div><div><small>可识别总额</small><strong>${money(total)}</strong></div><div><small>待核对</small><strong>${records.filter((r) => r.status === "待核对").length}</strong></div></div>
      <div class="panel-head" style="padding-left:0"><div><h2>缴费时间线</h2><p>原始记录与新增记录</p></div><button class="primary compact" data-add-for="${student.id}">＋ 记缴费</button></div>
      <div class="timeline">${records.map((record) => `<div class="timeline-item"><div class="timeline-head"><strong>${escapeHtml(record.term)}</strong><span class="money">${money(record.amount)}</span></div><p>${escapeHtml(record.note)}</p><small class="tag ${record.status === "已确认" ? "confirmed" : "review"}">${escapeHtml(record.status)} · ${escapeHtml(record.source)}</small></div>`).join("") || '<div class="empty">还没有缴费记录</div>'}</div>`;
    $("#drawerBackdrop").classList.add("show");
    $("#studentDrawer").classList.add("open");
  }

  function closeDrawer() {
    $("#drawerBackdrop").classList.remove("show");
    $("#studentDrawer").classList.remove("open");
  }

  function openPaymentModal(recordId = null, studentId = null) {
    const record = recordId ? state.records.find((item) => item.id === recordId) : null;
    const options = state.students.map((student) => `<option value="${student.id}" ${(record?.studentId || studentId) === student.id ? "selected" : ""}>${escapeHtml(student.name)}（${escapeHtml(student.subject)}）</option>`).join("");
    openModal(`
      <div class="modal-body"><h2>${record ? "编辑缴费记录" : "记一笔缴费"}</h2><p>保存后，其他已登录设备会自动同步。</p>
      <form id="paymentForm" class="form-grid">
        <input type="hidden" name="recordId" value="${record?.id || ""}">
        <div class="field full"><label>学员 *</label><select name="studentId" required>${options}</select></div>
        <div class="field"><label>学期 *</label><input name="term" required value="${escapeHtml(record?.term || "")}" placeholder="例如：26暑"></div>
        <div class="field"><label>金额（元）</label><input name="amount" type="number" min="0" step="0.01" value="${record?.amount ?? ""}" placeholder="3200"></div>
        <div class="field"><label>缴费日期</label><input name="paymentDate" type="date" value="${escapeHtml(record?.paymentDate || "")}"></div>
        <div class="field"><label>收款方式</label><select name="method">${["未记录","微信","支付宝","现金","银行转账","原表代码"].map((value) => `<option ${record?.method === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
        <div class="field"><label>核对状态</label><select name="status"><option ${record?.status === "已确认" ? "selected" : ""}>已确认</option><option ${record?.status !== "已确认" ? "selected" : ""}>待核对</option></select></div>
        <div class="field full"><label>备注 / 原始记录</label><textarea name="note">${escapeHtml(record?.note || "")}</textarea></div>
        <div class="modal-actions full"><button type="button" class="secondary" data-close="modal">取消</button><button class="primary" type="submit">保存并同步</button></div>
      </form></div>`);
  }

  function openStudentModal() {
    openModal(`<div class="modal-body"><h2>新增学员</h2><p>保存后会立即写入云端。</p>
      <form id="studentForm" class="form-grid">
        <div class="field full"><label>学员姓名 *</label><input name="name" required autofocus></div>
        <div class="field"><label>科目 *</label><select name="subject"><option>英语</option><option>数学</option><option>其他</option></select></div>
        <div class="field"><label>状态</label><select name="status"><option>在读</option><option>待确认</option><option>暂停</option><option>结课</option></select></div>
        <div class="field"><label>家长姓名</label><input name="guardian"></div><div class="field"><label>联系电话</label><input name="phone"></div>
        <div class="field full"><label>备注</label><textarea name="note"></textarea></div>
        <div class="modal-actions full"><button type="button" class="secondary" data-close="modal">取消</button><button class="primary" type="submit">保存并同步</button></div>
      </form></div>`);
  }

  function openImportProgress() {
    openModal(`<div class="modal-body"><h2>正在导入原 Excel 数据</h2><p>请保持页面打开。重复导入不会产生重复记录。</p>
      <div class="import-progress"><div class="progress-track"><div id="importProgressFill" class="progress-fill"></div></div>
      <div class="progress-label"><span id="importProgressText">准备导入</span><strong id="importProgressNumber">0%</strong></div></div></div>`);
  }

  function openModal(html) {
    $("#modalContent").innerHTML = html;
    $("#modalBackdrop").classList.add("show");
    $("#formModal").showModal();
  }

  function closeModal() {
    $("#modalBackdrop").classList.remove("show");
    if ($("#formModal").open) $("#formModal").close();
  }

  async function savePayment(form) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = "正在保存…";
    try {
      const data = Object.fromEntries(new FormData(form));
      const student = state.students.find((item) => item.id === data.studentId);
      if (!student) throw new Error("请选择学员");
      const payload = {
        workspace_id: workspace.id,
        student_id: student.id,
        student_name: student.name,
        subject: student.subject,
        term: data.term.trim(),
        amount: data.amount === "" ? null : Number(data.amount),
        payment_date: data.paymentDate || null,
        method: data.method,
        kind: "payment",
        status: data.status,
        note: data.note.trim(),
        source: data.recordId ? undefined : "系统新增",
        imported: false,
      };
      Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
      if (data.recordId) await api.updatePayment(data.recordId, payload);
      else await api.insertPayment(payload);
      closeModal();
      closeDrawer();
      await syncNow(false);
      showToast(data.recordId ? "缴费记录已更新并同步" : "缴费记录已保存并同步");
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
      button.textContent = "保存并同步";
    }
  }

  async function saveStudent(form) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      await api.insertStudent({
        workspace_id: workspace.id,
        name: data.name.trim(),
        subject: data.subject,
        status: data.status,
        guardian: data.guardian,
        phone: data.phone,
        note: data.note,
        imported: false,
      });
      closeModal();
      await syncNow(false);
      showToast("学员档案已创建并同步");
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }

  async function confirmRecord(id) {
    try {
      await api.updatePayment(id, { status: "已确认" });
      await syncNow(false);
      showToast("已确认并同步到云端");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function importPrivateData(file) {
    openImportProgress();
    try {
      const payload = JSON.parse(await file.text());
      const result = await api.importData(workspace.id, payload, (percent, label) => {
        $("#importProgressFill").style.width = `${percent}%`;
        $("#importProgressText").textContent = label;
        $("#importProgressNumber").textContent = `${percent}%`;
      });
      await syncNow(false);
      closeModal();
      showToast(`已导入 ${result.students} 位学员、${result.records} 条记录`);
    } catch (error) {
      closeModal();
      showToast(`导入失败：${error.message}`);
    } finally {
      $("#privateImportFile").value = "";
    }
  }

  function exportJson() {
    download(`缴费系统云端备份-${today()}.json`, JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), workspace: workspace.name, ...state }, null, 2), "application/json");
  }

  function exportCsv() {
    const headers = ["学员","科目","学期","金额","缴费日期","收款方式","状态","备注","来源"];
    const rows = filteredPayments().map((record) => [record.studentName, record.subject, record.term, record.amount ?? "", record.paymentDate, record.method, record.status, record.note, record.source]);
    const csv = "\ufeff" + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    download(`缴费记录-${today()}.csv`, csv, "text/csv;charset=utf-8");
  }

  function download(filename, text, type) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  document.addEventListener("click", async (event) => {
    const authTab = event.target.closest("[data-auth-tab]");
    if (authTab) {
      $$(".auth-tabs button").forEach((button) => button.classList.toggle("active", button === authTab));
      $("#loginForm").classList.toggle("hidden", authTab.dataset.authTab !== "login");
      $("#signupForm").classList.toggle("hidden", authTab.dataset.authTab !== "signup");
      setAuthMessage("");
    }
    const nav = event.target.closest("[data-view]"); if (nav) navigate(nav.dataset.view);
    const go = event.target.closest("[data-go]"); if (go) navigate(go.dataset.go);
    const student = event.target.closest("[data-student]"); if (student) openStudent(student.dataset.student);
    const edit = event.target.closest("[data-edit-record]"); if (edit) openPaymentModal(edit.dataset.editRecord);
    const confirm = event.target.closest("[data-confirm]"); if (confirm) await confirmRecord(confirm.dataset.confirm);
    const addFor = event.target.closest("[data-add-for]"); if (addFor) openPaymentModal(null, addFor.dataset.addFor);
    const close = event.target.closest("[data-close]"); if (close?.dataset.close === "modal") closeModal(); else if (close) closeDrawer();
  });

  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "loginForm") {
      const button = event.target.querySelector("button");
      button.disabled = true;
      setAuthMessage("正在登录…", true);
      try {
        const data = Object.fromEntries(new FormData(event.target));
        await api.signIn(data.email.trim(), data.password);
        await startApp();
      } catch (error) {
        setAuthMessage(error.message);
        button.disabled = false;
      }
    }
    if (event.target.id === "signupForm") {
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(event.target));
        const result = await api.signUp(data.email.trim(), data.password);
        if (result.access_token) await startApp();
        else setAuthMessage("注册成功，请先到邮箱完成验证，然后返回登录。", true);
      } catch (error) {
        setAuthMessage(error.message);
      } finally {
        button.disabled = false;
      }
    }
    if (event.target.id === "paymentForm") await savePayment(event.target);
    if (event.target.id === "studentForm") await saveStudent(event.target);
  });

  $("#addPaymentBtn").onclick = () => openPaymentModal();
  $("#addStudentBtn").onclick = openStudentModal;
  $("#syncNowBtn").onclick = () => syncNow(true);
  $("#exportBackupBtn").onclick = exportJson;
  $("#exportCsvBtn").onclick = exportCsv;
  $("#importDataBtn").onclick = () => $("#privateImportFile").click();
  $("#privateImportFile").addEventListener("change", (event) => event.target.files[0] && importPrivateData(event.target.files[0]));
  $("#logoutBtn").onclick = async () => {
    setLoading(true, "正在安全退出…");
    await api.signOut();
    location.reload();
  };
  $("#drawerBackdrop").onclick = closeDrawer;
  $("#modalBackdrop").onclick = closeModal;
  $("#globalSearch").addEventListener("input", (event) => { searchText = event.target.value.trim().toLowerCase(); studentPage = paymentPage = reviewPage = 1; render(); });
  $("#studentSubjectFilter").addEventListener("click", (event) => {
    const button = event.target.closest("button"); if (!button) return;
    studentSubject = button.dataset.value; studentPage = 1;
    $$("#studentSubjectFilter button").forEach((item) => item.classList.toggle("active", item === button));
    renderStudents();
  });
  ["paymentSubjectFilter","paymentTermFilter","paymentStatusFilter"].forEach((id) => $(`#${id}`).addEventListener("change", () => { paymentPage = 1; renderPayments(); }));
  $("#reviewKindFilter").addEventListener("change", () => { reviewPage = 1; renderReview(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && workspace) syncNow(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDrawer(); closeModal(); } });

  if (!api.isConfigured()) {
    $("#configRequired").classList.remove("hidden");
    $("#authForms").classList.add("hidden");
  } else {
    const session = await api.ensureSession();
    if (session) await startApp();
  }
})();
