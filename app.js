(() => {
  "use strict";

  const roleLabels = { owner: "Owner", partner: "Partner", reseller: "Reseller" };
  const roleCodes = { owner: "OW", partner: "PT", reseller: "RS" };
  const pageLabels = {
    overview: "Ringkasan",
    licenses: "Lisensi nomor",
    accounts: "Manajemen akun",
    settings: "Pengaturan",
  };
  const state = {
    account: null,
    accounts: [],
    licenses: [],
    announcement: null,
    csrfToken: "",
    botPasswordConfigured: false,
  };
  let currentPage = "overview";
  let activeFilter = "all";
  let modalMode = "";
  let pendingDeletion = null;
  let toastTimeout;
  let modalScrollDrag = null;
  let lastFocusedElement = null;
  const themeStorageKey = "lloyd-license-theme";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const passwordToggleMarkup = () => '<button class="password-toggle" type="button" data-password-toggle aria-label="Tampilkan password" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m4 4 16 16"/></svg></button>';
  const roleName = (role) => roleLabels[role] || "Akun";
  const roleCode = (role) => roleCodes[role] || "—";
  const isOwner = () => state.account?.role === "owner";
  const isPartner = () => state.account?.role === "partner";
  const isReseller = () => state.account?.role === "reseller";

  function applyTheme(theme, persist = false) {
    const selectedTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.style.colorScheme = selectedTheme;
    document.querySelector('meta[name="theme-color"]').content = selectedTheme === "dark" ? "#171a18" : "#f4f3ed";
    $$("[data-theme-choice]").forEach((button) => {
      const selected = button.dataset.themeChoice === selectedTheme;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    if (persist) localStorage.setItem(themeStorageKey, selectedTheme);
  }

  function showToast(message) {
    $("#toastMessage").textContent = message;
    $("#toast").classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => $("#toast").classList.remove("show"), 3200);
  }

  function showLogin(message = "", refreshCsrf = false) {
    state.account = null;
    state.accounts = [];
    state.licenses = [];
    state.botPasswordConfigured = false;
    state.csrfToken = "";
    $("#appShell").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
    $("#loginForm button[type='submit']").disabled = true;
    $("#loginError").textContent = message;
    $("#loginError").classList.toggle("hidden", !message);
    $("#loginForm").reset();
    if (refreshCsrf) {
      getCsrfToken().catch((error) => {
        $("#loginError").textContent = error.message;
        $("#loginError").classList.remove("hidden");
      });
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.method && options.method !== "GET" && state.csrfToken) {
      headers.set("X-CSRF-Token", state.csrfToken);
    }
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        credentials: "same-origin",
      });
    } catch {
      throw new Error("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    }
    if (response.status === 401 && !path.endsWith("/auth/login")) {
      showLogin("Sesi berakhir. Silakan masuk kembali.", true);
    }
    if (response.status === 204) return null;
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Server mengirim respons yang tidak dapat dibaca.");
    }
    if (!response.ok) throw new Error(data.error || `Permintaan gagal (${response.status}).`);
    return data;
  }

  async function getCsrfToken() {
    const result = await api("/api/auth/csrf");
    if (typeof result.csrfToken !== "string" || !result.csrfToken) {
      throw new Error("Server tidak mengirim token keamanan.");
    }
    state.csrfToken = result.csrfToken;
    $("#loginForm button[type='submit']").disabled = false;
  }

  async function loadPortalData() {
    const requests = [
      api("/api/accounts"),
      api("/api/licenses"),
      api("/api/announcement"),
    ];
    if (isOwner()) requests.push(api("/api/bot/password"));
    const [accountsResult, licensesResult, announcementResult, botPasswordResult] = await Promise.all(requests);
    state.accounts = accountsResult.accounts;
    state.licenses = licensesResult.licenses;
    state.announcement = announcementResult.announcement;
    state.botPasswordConfigured = Boolean(botPasswordResult?.configured);
    render();
  }

  function showAnnouncement() {
    if (!state.announcement) return;
    openModal("announcement", {
      title: state.announcement.title,
      description: `Pengumuman dari Owner · ${formatDate(state.announcement.updatedAt)}`,
      step: "PENGUMUMAN",
      message: state.announcement.message,
    });
  }

  async function bootstrap() {
    try {
      await getCsrfToken();
      const result = await api("/api/auth/me");
      state.account = result.account;
      await loadPortalData();
      $("#loginScreen").classList.add("hidden");
      $("#appShell").classList.remove("hidden");
      showAnnouncement();
    } catch (error) {
      if (!state.account) showLogin(error.message.includes("Sesi") ? error.message : "");
      if (!error.message.includes("Silakan masuk")) {
        $("#loginError").textContent = error.message;
        $("#loginError").classList.toggle("hidden", !error.message);
      }
    }
  }

  async function refreshData() {
    try {
      await loadPortalData();
      showToast("Data berhasil dimuat ulang.");
    } catch (error) {
      showToast(error.message);
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function setPage(page) {
    if (!pageLabels[page]) return;
    if (page === "accounts" && isReseller()) return;
    currentPage = page;
    $$(".page-view").forEach((view) => view.classList.toggle("active", view.id === `page-${page}`));
    $$(".nav-link[data-page]").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
    $("#breadcrumbPage").textContent = pageLabels[page];
    $("#sidebar").classList.remove("mobile-open");
    $("#mobileMenu").setAttribute("aria-expanded", "false");
  }

  function visibleResellerName(license) {
    const reseller = state.accounts.find((account) => account.id === license.resellerId);
    if (reseller) return reseller.name;
    return license.resellerId === state.account?.id ? state.account.name : "Akun reseller";
  }

  function canDeleteLicense(license) {
    if (isOwner()) return true;
    if (isReseller()) return license.createdById === state.account.id;
    if (!isPartner()) return false;
    const childIds = new Set(state.accounts.filter((account) => account.role === "reseller").map((account) => account.id));
    return license.createdById === state.account.id
      || childIds.has(license.createdById)
      || childIds.has(license.resellerId);
  }

  function canDeleteAccount(account) {
    return isOwner()
      || (isPartner() && account.role === "reseller" && account.parentId === state.account.id);
  }

  function renderOverview() {
    const activeLicenses = state.licenses.filter((license) => license.status === "active").length;
    $("#statLicenses").textContent = String(state.licenses.length).padStart(2, "0");
    $("#statActive").textContent = String(activeLicenses).padStart(2, "0");
    $("#statPartners").textContent = isOwner()
      ? String(state.accounts.filter((account) => account.role === "partner").length).padStart(2, "0")
      : isPartner() ? "01" : "—";
    $("#statResellers").textContent = isOwner()
      ? String(state.accounts.filter((account) => account.role === "reseller").length).padStart(2, "0")
      : isPartner() ? String(state.accounts.filter((account) => account.role === "reseller").length).padStart(2, "0") : "—";

    const rows = state.licenses.slice(0, 5);
    $("#overviewLicenseRows").innerHTML = rows.map((license) => `
      <tr>
        <td><strong class="mono-cell">${escapeHtml(license.phone)}</strong></td>
        <td>${escapeHtml(visibleResellerName(license))}</td>
        <td><span class="status-badge ${license.status === "active" ? "status-active" : "status-inactive"}"><i></i>${license.status === "active" ? "Aktif" : "Nonaktif"}</span></td>
        <td>${formatDate(license.createdAt)}</td>
      </tr>`).join("");
    $("#overviewEmpty").classList.toggle("hidden", rows.length > 0);
    $("#networkTotal").textContent = `${state.accounts.length + 1} AKUN`;
    renderNetwork();
  }

  function renderNetwork() {
    const rootName = state.account.name;
    const rootRole = roleName(state.account.role);
    let branches = [];
    if (isOwner()) {
      branches = state.accounts.filter((account) => account.role === "partner").map((partner) => ({
        account: partner,
        resellers: state.accounts.filter((account) => account.role === "reseller" && account.parentId === partner.id),
      }));
      const directResellers = state.accounts.filter((account) => account.role === "reseller" && !account.parentId);
      if (directResellers.length) branches.push({ account: null, resellers: directResellers });
    } else if (isPartner()) {
      branches = [{ account: state.account, resellers: state.accounts.filter((account) => account.role === "reseller") }];
    } else {
      branches = [{ account: state.account, resellers: [] }];
    }
    $("#networkBranches").innerHTML = branches.map((branch) => {
      const label = branch.account ? branch.account.name : "Reseller langsung";
      const count = branch.resellers.length;
      return `<div class="branch-column"><div class="network-node partner-node"><span class="node-avatar">${roleCode(branch.account?.role || "partner")}</span><span><strong>${escapeHtml(label)}</strong><small>${branch.account ? roleName(branch.account.role).toUpperCase() : "AKUN OWNER"}</small></span><span class="node-status" title="${count} reseller"></span></div>
        ${branch.resellers.map((reseller) => `<div class="reseller-leaf"><span class="leaf-dot"></span><span>${escapeHtml(reseller.name)}</span></div>`).join("")}</div>`;
    }).join("") || '<div class="network-hint">Belum ada akun turunan.</div>';
    $("#networkRootName").textContent = rootName;
    $("#networkRootRole").textContent = rootRole.toUpperCase();
  }

  function renderLicenses() {
    const query = $("#licenseSearch").value.trim().toLowerCase();
    const filtered = state.licenses.filter((license) => {
      const matchesStatus = activeFilter === "all" || license.status === activeFilter;
      const matchesSearch = license.phone.includes(query) || visibleResellerName(license).toLowerCase().includes(query);
      return matchesStatus && matchesSearch;
    });
    $("#filterAllCount").textContent = state.licenses.length;
    $("#filterActiveCount").textContent = state.licenses.filter((license) => license.status === "active").length;
    $("#filterInactiveCount").textContent = state.licenses.filter((license) => license.status === "inactive").length;
    $("#licenseRows").innerHTML = filtered.map((license) => `
      <tr>
        <td><strong class="mono-cell">${escapeHtml(license.phone)}</strong></td>
        <td>${escapeHtml(visibleResellerName(license))}</td>
        <td><span class="status-badge ${license.status === "active" ? "status-active" : "status-inactive"}"><i></i>${license.status === "active" ? "Aktif" : "Nonaktif"}</span></td>
        <td>${formatDate(license.createdAt)}</td>
        <td><div class="row-actions">
          ${isOwner() ? `<button class="table-action" data-action="toggle-license" data-id="${escapeHtml(license.id)}" aria-label="${license.status === "active" ? "Nonaktifkan" : "Aktifkan"} lisensi">◉</button>` : ""}
          ${canDeleteLicense(license) ? `<button class="table-action table-action-danger" data-action="delete-license" data-id="${escapeHtml(license.id)}" aria-label="Hapus nomor ${escapeHtml(license.phone)}">×</button>` : ""}
        </div></td>
      </tr>`).join("");
    $("#licenseEmpty").classList.toggle("hidden", state.licenses.length > 0);
    $("#licenseNoResults").classList.toggle("hidden", filtered.length > 0 || state.licenses.length === 0);
    $("#licenseTableCount").textContent = `Menampilkan ${filtered.length} dari ${state.licenses.length} data`;
  }

  function renderAccounts() {
    const query = $("#accountSearch").value.trim().toLowerCase();
    const filtered = state.accounts.filter((account) =>
      `${account.name} ${account.email} ${account.role}`.toLowerCase().includes(query));
    $("#accountsTableTitle").textContent = isOwner() ? "Semua akun" : "Reseller saya";
    $("#accountSummary").innerHTML = `
      <div class="account-summary-card"><span>${isOwner() ? "PARTNER" : "RESELLER"}</span><strong>${isOwner()
        ? state.accounts.filter((account) => account.role === "partner").length
        : state.accounts.filter((account) => account.role === "reseller").length}</strong></div>
      <div class="account-summary-card"><span>${isOwner() ? "RESELLER" : "LISENSI"}</span><strong>${isOwner()
        ? state.accounts.filter((account) => account.role === "reseller").length
        : state.licenses.length}</strong></div>`;
    $("#accountRows").innerHTML = filtered.map((account) => `
      <tr>
        <td><strong>${escapeHtml(account.name)}</strong></td>
        <td>${escapeHtml(account.email)}</td>
        <td><span class="role-pill role-${escapeHtml(account.role)}">${roleName(account.role)}</span></td>
        <td>${formatDate(account.createdAt)}</td>
        <td><span class="status-badge ${account.status === "active" ? "status-active" : "status-inactive"}"><i></i>${account.status === "active" ? "Aktif" : "Nonaktif"}</span></td>
        <td><div class="row-actions">${isOwner() ? `<button class="table-action" data-action="toggle-account" data-id="${escapeHtml(account.id)}" aria-label="${account.status === "active" ? "Nonaktifkan" : "Aktifkan"} akun">◉</button>` : ""}
          ${canDeleteAccount(account) ? `<button class="table-action table-action-danger" data-action="delete-account" data-id="${escapeHtml(account.id)}" aria-label="Hapus akun ${escapeHtml(account.name)}">×</button>` : ""}</div></td>
      </tr>`).join("");
    $("#accountEmpty").classList.toggle("hidden", state.accounts.length > 0);
    $("#accountNoResults").classList.toggle("hidden", filtered.length > 0 || state.accounts.length === 0);
    $("#accountTableCount").textContent = `Menampilkan ${filtered.length} dari ${state.accounts.length} akun`;
  }

  function renderHeaderAndPermissions() {
    const account = state.account;
    $("#sidebarName").textContent = account.name;
    $("#sidebarRole").textContent = roleName(account.role).toUpperCase();
    $("#sidebarAvatar").textContent = roleCode(account.role);
    $("#sidebarAvatar").className = `avatar avatar-${account.role}`;
    $("#networkRootCode").textContent = roleCode(account.role);
    $("#navLicenseCount").textContent = state.licenses.length;
    $("#currentDate").textContent = new Intl.DateTimeFormat("id-ID", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric",
    }).format(new Date()).toUpperCase();
    $("#settingsAccountName").textContent = account.name;
    $("#settingsAccountEmail").textContent = account.email;
    $("#settingsAccountRole").textContent = `${roleName(account.role)} · ${account.status || "active"}`;
    $("#botPasswordSettings").classList.toggle("hidden", !isOwner());
    if (isOwner()) {
      $("#botPasswordStatus").textContent = state.botPasswordConfigured
        ? "Password sudah diatur"
        : "Password belum diatur";
      $("#announcementSettings").classList.remove("hidden");
      $("#announcementStatus").textContent = state.announcement
        ? `Aktif · diperbarui ${formatDate(state.announcement.updatedAt)}`
        : "Belum ada pengumuman aktif";
      $("#editAnnouncementButton").textContent = state.announcement ? "Ubah pengumuman" : "Buat pengumuman";
    } else {
      $("#announcementSettings").classList.add("hidden");
    }

    const showCreateAccount = isOwner() || isPartner();
    $("#addAccountButton").classList.toggle("hidden", !showCreateAccount);
    $("#accountHeadingActions").classList.toggle("hidden", !showCreateAccount);
    $("#licenseHeadingActions").classList.remove("hidden");
    $('[data-page="accounts"]').classList.toggle("hidden", isReseller());
    $("#primaryActionText").textContent = showCreateAccount ? "Buat akun" : "Daftarkan nomor";
    $("#primaryAction").classList.toggle("hidden", !(showCreateAccount || isReseller()));
    if (currentPage === "accounts" && isReseller()) setPage("overview");
  }

  function render() {
    if (!state.account) return;
    renderHeaderAndPermissions();
    renderOverview();
    renderLicenses();
    renderAccounts();
  }

  function openModal(mode, options = {}) {
    modalMode = mode;
    pendingDeletion = options.deletion || null;
    lastFocusedElement = document.activeElement;
    $("#modalBackdrop").classList.add("open");
    $("#modalBackdrop").setAttribute("aria-hidden", "false");
    $("#modalTitle").innerHTML = `${escapeHtml(options.title || "Buat akun baru")}<span class="heading-period">.</span>`;
    $("#modalDescription").textContent = options.description || "";
    $("#modalStep").textContent = options.step || "FORM / 01";
    const form = $("#modalForm");
    form.className = "modal-form";

    if (mode === "account") {
      const roleOptions = isOwner()
        ? `<label class="field-label">Role akun<select name="role" required><option value="partner">Partner</option><option value="reseller">Reseller</option></select></label>`
        : '<input type="hidden" name="role" value="reseller">';
      const parentOptions = isOwner()
        ? `<label class="field-label" id="parentField">Partner induk (opsional)<select name="parentId"><option value="">Reseller langsung</option>${state.accounts.filter((account) => account.role === "partner" && account.status === "active").map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label>`
        : "";
      form.innerHTML = `
        <label class="field-label">Nama akun (username login)<input name="name" minlength="2" maxlength="60" autocomplete="username" required></label>
        <label class="field-label">Email akun<input name="email" type="email" maxlength="120" autocomplete="email" required></label>
        ${roleOptions}
        ${parentOptions}
        <label class="field-label">Password awal<small>Minimal 8 karakter; bagikan secara aman kepada pengguna.</small><div class="password-control"><input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>${passwordToggleMarkup()}</div></label>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <button class="button button-primary modal-submit" type="submit">Buat akun</button>`;
      if (isOwner()) {
        const roleSelect = form.elements.role;
        roleSelect.addEventListener("change", () => {
          $("#parentField").classList.toggle("hidden", roleSelect.value !== "reseller");
        });
        $("#parentField").classList.add("hidden");
      }
    } else if (mode === "license") {
      form.innerHTML = `
        <label class="field-label">Nomor WhatsApp<small>Format internasional, 8–15 digit tanpa tanda +.</small><input name="phone" inputmode="numeric" minlength="8" maxlength="15" pattern="[1-9][0-9]{7,14}" placeholder="6281234567890" required></label>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <button class="button button-primary modal-submit" type="submit">Daftarkan nomor</button>`;
    } else if (mode === "profile") {
      form.innerHTML = `
        <label class="field-label">Nama tampilan / username login<input name="name" minlength="2" maxlength="60" autocomplete="username" value="${escapeHtml(state.account.name)}" required></label>
        <label class="field-label">Email akun<input name="email" type="email" maxlength="120" autocomplete="email" value="${escapeHtml(state.account.email)}" required></label>
        <label class="field-label">Password saat ini<div class="password-control"><input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required>${passwordToggleMarkup()}</div></label>
        <label class="field-label">Password baru<small>Kosongkan jika tidak ingin mengganti password. Minimal 8 karakter.</small><div class="password-control"><input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password">${passwordToggleMarkup()}</div></label>
        <label class="field-label">Ulangi password baru<div class="password-control"><input name="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password">${passwordToggleMarkup()}</div></label>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <button class="button button-primary modal-submit" type="submit">Simpan perubahan profil</button>`;
    } else if (mode === "announcement-edit") {
      form.innerHTML = `
        <label class="field-label">Judul pengumuman<input name="title" maxlength="120" value="${escapeHtml(state.announcement?.title || "")}" required></label>
        <label class="field-label">Isi pengumuman<small>Maksimal 3000 karakter.</small><textarea name="message" maxlength="3000" rows="5" required>${escapeHtml(state.announcement?.message || "")}</textarea></label>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <div class="announcement-actions"><button class="button button-primary" type="submit">${state.announcement ? "Simpan pengumuman" : "Terbitkan pengumuman"}</button>${state.announcement ? '<button class="button button-danger" type="button" data-delete-announcement>Hapus pengumuman</button>' : ""}</div>`;
    } else if (mode === "bot-password") {
      form.innerHTML = `
        <label class="field-label">Password baru<small>Minimal 12 karakter.</small><div class="password-control"><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>${passwordToggleMarkup()}</div></label>
        <label class="field-label">Ulangi password<div class="password-control"><input name="confirmPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>${passwordToggleMarkup()}</div></label>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <button class="button button-primary modal-submit" type="submit">Simpan password script</button>`;
    } else if (mode === "confirm-delete") {
      form.innerHTML = `
        <div class="delete-confirmation"><span class="delete-confirmation-icon">!</span><p>${escapeHtml(options.impact)}</p></div>
        <p class="form-error hidden" id="modalError" role="alert"></p>
        <div class="confirmation-actions"><button class="button button-secondary" type="button" data-cancel>Batalkan</button><button class="button button-primary" type="submit">Hapus permanen</button></div>`;
    } else if (mode === "announcement") {
      form.innerHTML = `
        <div class="announcement-message">${escapeHtml(options.message).replace(/\n/g, "<br>")}</div>
        <button class="button button-primary modal-submit" type="button" data-close>Tutup</button>`;
    }
    $("#modalBackdrop").querySelector(".modal").scrollTop = 0;
    form.scrollTop = 0;
    updateModalScrollbar();
    $("#modalClose").focus();
  }

  function closeModal() {
    $("#modalBackdrop").classList.remove("open");
    $("#modalBackdrop").setAttribute("aria-hidden", "true");
    $("#modalForm").innerHTML = "";
    $("#modalForm").className = "";
    modalMode = "";
    pendingDeletion = null;
    modalScrollDrag = null;
    if (lastFocusedElement?.isConnected) lastFocusedElement.focus();
  }

  function updateModalScrollbar() {
    const form = $("#modalForm");
    const track = $("#modalScrollTrack");
    const thumb = $("#modalScrollThumb");
    if (!form || !track || !thumb || !modalMode) return;
    const scrollable = form.scrollHeight > form.clientHeight + 1;
    track.classList.toggle("visible", scrollable);
    if (!scrollable) return;
    const ratio = form.clientHeight / form.scrollHeight;
    thumb.style.height = `${Math.max(28, track.clientHeight * ratio)}px`;
    thumb.style.transform = `translateY(${(track.clientHeight - thumb.offsetHeight) * form.scrollTop / (form.scrollHeight - form.clientHeight)}px)`;
    track.setAttribute("aria-valuenow", String(Math.round(100 * form.scrollTop / (form.scrollHeight - form.clientHeight))));
  }

  function setModalScrollFromPointer(clientY) {
    const form = $("#modalForm");
    const track = $("#modalScrollTrack");
    const thumb = $("#modalScrollThumb");
    const bounds = track.getBoundingClientRect();
    const distance = Math.max(0, track.clientHeight - thumb.offsetHeight);
    const thumbTop = Math.min(distance, Math.max(0, clientY - bounds.top - modalScrollDrag.offset));
    form.scrollTop = distance ? thumbTop / distance * (form.scrollHeight - form.clientHeight) : 0;
    updateModalScrollbar();
  }

  async function submitModal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const errorBox = $("#modalError");
    errorBox?.classList.add("hidden");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (modalMode === "account") {
        const formData = new FormData(form);
        const body = {
          name: formData.get("name"),
          email: formData.get("email"),
          password: formData.get("password"),
          role: formData.get("role"),
        };
        if (formData.get("parentId")) body.parentId = formData.get("parentId");
        await api("/api/accounts", { method: "POST", body: JSON.stringify(body) });
        closeModal();
        try {
          await loadPortalData();
          showToast("Akun berhasil dibuat.");
        } catch (error) {
          showToast(`Akun dibuat, tetapi data gagal dimuat ulang: ${error.message}`);
        }
      } else if (modalMode === "license") {
        const phone = new FormData(form).get("phone");
        await api("/api/licenses", { method: "POST", body: JSON.stringify({ phone }) });
        closeModal();
        try {
          await loadPortalData();
          showToast("Nomor berhasil didaftarkan.");
        } catch (error) {
          showToast(`Lisensi dibuat, tetapi data gagal dimuat ulang: ${error.message}`);
        }
      } else if (modalMode === "profile") {
        const values = new FormData(form);
        const newPassword = values.get("newPassword");
        if (newPassword !== values.get("confirmPassword")) throw new Error("Konfirmasi password baru tidak sama.");
        const result = await api("/api/auth/profile", {
          method: "PATCH",
          body: JSON.stringify({
            name: values.get("name"),
            email: values.get("email"),
            currentPassword: values.get("currentPassword"),
            newPassword,
          }),
        });
        state.account = result.account;
        closeModal();
        render();
        showToast("Profil berhasil diperbarui.");
      } else if (modalMode === "announcement-edit") {
        const values = new FormData(form);
        const result = await api("/api/announcement", {
          method: "POST",
          body: JSON.stringify({ title: values.get("title"), message: values.get("message") }),
        });
        state.announcement = result.announcement;
        closeModal();
        render();
        showToast("Pengumuman berhasil diterbitkan.");
      } else if (modalMode === "bot-password") {
        const values = new FormData(form);
        const password = values.get("password");
        if (password !== values.get("confirmPassword")) throw new Error("Konfirmasi password tidak sama.");
        await api("/api/bot/password", {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        state.botPasswordConfigured = true;
        closeModal();
        render();
        showToast("Password script berhasil diperbarui.");
      } else if (modalMode === "confirm-delete" && pendingDeletion) {
        const deletion = pendingDeletion;
        const endpoint = deletion.type === "account"
          ? `/api/accounts/${encodeURIComponent(deletion.id)}`
          : deletion.type === "announcement" ? "/api/announcement" : `/api/licenses/${encodeURIComponent(deletion.id)}`;
        await api(endpoint, { method: "DELETE" });
        closeModal();
        try {
          await loadPortalData();
          showToast(deletion.type === "account"
            ? "Akun berhasil dihapus."
            : deletion.type === "announcement" ? "Pengumuman berhasil dihapus." : "Lisensi berhasil dihapus.");
        } catch (error) {
          showToast(`Data terhapus, tetapi daftar gagal dimuat ulang: ${error.message}`);
        }
      }
    } catch (error) {
      if (errorBox?.isConnected) {
        errorBox.textContent = error.message;
        errorBox.classList.remove("hidden");
      } else showToast(error.message);
    } finally {
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  function requestDeleteLicense(id) {
    const license = state.licenses.find((item) => item.id === id);
    if (!license) return;
    openModal("confirm-delete", {
      title: "Hapus lisensi",
      description: "Tindakan ini tidak dapat dibatalkan.",
      step: "KONFIRMASI",
      impact: `Lisensi nomor ${license.phone} akan dihapus permanen. Bot dengan nomor ini tidak akan dapat lolos verifikasi lisensi.`,
      deletion: { type: "license", id },
    });
  }

  function requestDeleteAccount(id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!account) return;
    const childCount = state.accounts.filter((item) => item.parentId === id).length;
    const impact = account.role === "partner"
      ? `Akun Partner ${account.name} akan dihapus dan lisensi yang dibuat akun ini ikut dihapus. ${childCount} akun reseller akan dipertahankan sebagai reseller langsung tanpa Partner induk.`
      : `Akun ${account.name} dan lisensi yang terkait akan dihapus permanen.`;
    openModal("confirm-delete", {
      title: "Hapus akun",
      description: "Tindakan ini tidak dapat dibatalkan.",
      step: "KONFIRMASI",
      impact,
      deletion: { type: "account", id },
    });
  }

  async function handleTableAction(action) {
    const { action: type, id } = action.dataset;
    try {
      if (type === "delete-license") return requestDeleteLicense(id);
      if (type === "delete-account") return requestDeleteAccount(id);
      if (type === "toggle-license") {
        const license = state.licenses.find((item) => item.id === id);
        if (!license) return;
        await api(`/api/licenses/${encodeURIComponent(id)}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: license.status === "active" ? "inactive" : "active" }),
        });
      } else if (type === "toggle-account") {
        const account = state.accounts.find((item) => item.id === id);
        if (!account) return;
        await api(`/api/accounts/${encodeURIComponent(id)}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: account.status === "active" ? "inactive" : "active" }),
        });
      }
      await loadPortalData();
      showToast("Perubahan berhasil disimpan.");
    } catch (error) {
      showToast(error.message);
    }
  }

  function exportCsv() {
    const rows = [
      ["Nomor WhatsApp", "Reseller", "Status", "Tanggal dibuat"],
      ...state.licenses.map((license) => [
        license.phone,
        visibleResellerName(license),
        license.status === "active" ? "Aktif" : "Nonaktif",
        formatDate(license.createdAt),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "lloyd-lisensi.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      state.csrfToken = "";
      showLogin();
      await getCsrfToken();
    } catch (error) {
      showToast(error.message);
    }
  }

  function attachEvents() {
    $$("[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () => applyTheme(button.dataset.themeChoice, true));
    });
    document.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-password-toggle]");
      if (!toggle) return;
      const input = toggle.parentElement.querySelector("input");
      const isVisible = input.type === "password";
      input.type = isVisible ? "text" : "password";
      toggle.setAttribute("aria-label", `${isVisible ? "Sembunyikan" : "Tampilkan"} password`);
      toggle.setAttribute("aria-pressed", String(isVisible));
    });
    $("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      $("#loginError").classList.add("hidden");
      try {
        const values = new FormData(event.currentTarget);
        const result = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: values.get("username"), password: values.get("password") }),
        });
        state.account = result.account;
        state.csrfToken = result.csrfToken;
        await loadPortalData();
        $("#loginScreen").classList.add("hidden");
        $("#appShell").classList.remove("hidden");
        setPage("overview");
        showAnnouncement();
      } catch (error) {
        $("#loginError").textContent = error.message;
        $("#loginError").classList.remove("hidden");
      } finally {
        submit.disabled = false;
      }
    });
    $("#logoutButton").addEventListener("click", logout);
    $("#settingsLogout").addEventListener("click", logout);
    $("#refreshButton").addEventListener("click", refreshData);
    $("#mobileMenu").addEventListener("click", () => {
      const isOpen = $("#sidebar").classList.toggle("mobile-open");
      $("#mobileMenu").setAttribute("aria-expanded", String(isOpen));
    });
    $("#exportButton").addEventListener("click", exportCsv);
    $$("[data-goto]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.goto)));
    $("#primaryAction").addEventListener("click", () => openModal(isReseller() ? "license" : "account", {
      title: isReseller() ? "Daftarkan nomor" : "Buat akun baru",
      description: isReseller() ? "Tambahkan nomor bot ke daftar lisensi." : "Tambahkan pengguna ke jaringan portal.",
    }));
    $("#addAccountButton").addEventListener("click", () => openModal("account", {
      title: "Buat akun baru",
      description: "Tambahkan pengguna ke jaringan portal.",
    }));
    $("#addNumberButton").addEventListener("click", () => openModal("license", {
      title: "Daftarkan nomor",
      description: "Tambahkan nomor bot ke daftar lisensi.",
    }));
    $("#editProfileButton").addEventListener("click", () => openModal("profile", {
      title: "Ubah profil",
      description: "Perbarui username, email, atau password akun Anda.",
      step: "PROFIL / 01",
    }));
    $("#editAnnouncementButton").addEventListener("click", () => openModal("announcement-edit", {
      title: state.announcement ? "Ubah pengumuman" : "Buat pengumuman",
      description: "Pengumuman akan muncul sebagai pop-up setiap kali pengguna masuk.",
      step: "PENGUMUMAN / 01",
    }));
    $("#editBotPasswordButton").addEventListener("click", () => openModal("bot-password", {
      title: "Password script",
      description: "Gunakan password minimal 12 karakter. Password tersimpan sebagai hash.",
      step: "AKSES BOT / 01",
    }));
    $("#licenseSearch").addEventListener("input", renderLicenses);
    $("#accountSearch").addEventListener("input", renderAccounts);
    $("#licenseFilters").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-filter]");
      if (!tab) return;
      activeFilter = tab.dataset.filter;
      $$(".filter-tab").forEach((item) => item.classList.toggle("active", item === tab));
      renderLicenses();
    });
    $$(".nav-link[data-page]").forEach((link) => link.addEventListener("click", () => setPage(link.dataset.page)));
    $("#accountRows").addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (action) handleTableAction(action);
    });
    $("#licenseRows").addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (action) handleTableAction(action);
    });
    $("#modalClose").addEventListener("click", closeModal);
    $("#modalBackdrop").addEventListener("click", (event) => {
      if (event.target === $("#modalBackdrop")) closeModal();
    });
    $("#modalForm").addEventListener("submit", submitModal);
    $("#modalForm").addEventListener("click", (event) => {
      if (event.target.closest("[data-cancel], [data-close]")) return closeModal();
      if (event.target.closest("[data-delete-announcement]")) {
        openModal("confirm-delete", {
          title: "Hapus pengumuman",
          description: "Pengumuman tidak akan ditampilkan lagi kepada pengguna.",
          step: "KONFIRMASI",
          impact: "Pengumuman aktif akan dihapus dan tidak lagi muncul saat pengguna masuk.",
          deletion: { type: "announcement" },
        });
      }
    });
    $("#modalForm").addEventListener("scroll", updateModalScrollbar);
    $("#modalScrollTrack").addEventListener("pointerdown", (event) => {
      if (!$("#modalScrollTrack").classList.contains("visible")) return;
      const thumb = $("#modalScrollThumb");
      const thumbRect = thumb.getBoundingClientRect();
      modalScrollDrag = { offset: event.clientY >= thumbRect.top && event.clientY <= thumbRect.bottom
        ? event.clientY - thumbRect.top : thumb.offsetHeight / 2 };
      $("#modalScrollTrack").classList.add("dragging");
      $("#modalScrollTrack").setPointerCapture(event.pointerId);
      setModalScrollFromPointer(event.clientY);
    });
    $("#modalScrollTrack").addEventListener("pointermove", (event) => {
      if (modalScrollDrag) setModalScrollFromPointer(event.clientY);
    });
    $("#modalScrollTrack").addEventListener("pointerup", () => {
      modalScrollDrag = null;
      $("#modalScrollTrack").classList.remove("dragging");
    });
    $("#modalScrollTrack").addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        $("#modalForm").scrollTop += event.key === "ArrowDown" ? 80 : -80;
      } else if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        $("#modalForm").scrollTop += event.key === "PageDown" ? $("#modalForm").clientHeight : -$("#modalForm").clientHeight;
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        $("#modalForm").scrollTop = event.key === "Home" ? 0 : $("#modalForm").scrollHeight;
      }
      updateModalScrollbar();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("#modalBackdrop").classList.contains("open")) closeModal();
    });
    window.addEventListener("resize", updateModalScrollbar);
  }

  applyTheme(localStorage.getItem(themeStorageKey));
  attachEvents();
  bootstrap();
})();
