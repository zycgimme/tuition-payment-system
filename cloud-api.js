(function () {
  class CloudApi {
    constructor(config) {
      this.config = config;
      this.url = String(config.supabaseUrl || "").replace(/\/$/, "");
      this.key = String(config.publishableKey || "");
      this.sessionKey = "payment-cloud-session-v1";
      this.session = this.readSession();
    }

    isConfigured() {
      if (this.config.allowLocalTesting === true && /^http:\/\/127\.0\.0\.1:\d+$/.test(this.url)) return true;
      return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(this.url) &&
        this.key.length > 30 &&
        !this.url.includes("YOUR_PROJECT") &&
        !this.key.includes("YOUR_SUPABASE");
    }

    readSession() {
      try { return JSON.parse(localStorage.getItem(this.sessionKey)) || null; } catch (_) { return null; }
    }

    writeSession(session) {
      if (session && !session.expires_at && session.expires_in) {
        session.expires_at = Math.floor(Date.now() / 1000) + Number(session.expires_in);
      }
      this.session = session;
      if (session) localStorage.setItem(this.sessionKey, JSON.stringify(session));
      else localStorage.removeItem(this.sessionKey);
    }

    async signUp(email, password) {
      const data = await this.request("/auth/v1/signup", {
        method: "POST",
        auth: false,
        body: { email, password },
      });
      if (data.access_token) this.writeSession(data);
      return data;
    }

    async signIn(email, password) {
      const data = await this.request("/auth/v1/token?grant_type=password", {
        method: "POST",
        auth: false,
        body: { email, password },
      });
      this.writeSession(data);
      return data;
    }

    async signOut() {
      try {
        if (this.session?.access_token) {
          await this.request("/auth/v1/logout", { method: "POST" });
        }
      } finally {
        this.writeSession(null);
      }
    }

    async ensureSession() {
      if (!this.session?.access_token) return null;
      const expiresAt = this.session.expires_at || 0;
      if (expiresAt && expiresAt > Math.floor(Date.now() / 1000) + 60) return this.session;
      if (!this.session.refresh_token) return null;
      try {
        const data = await this.request("/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          auth: false,
          body: { refresh_token: this.session.refresh_token },
        });
        this.writeSession(data);
        return data;
      } catch (_) {
        this.writeSession(null);
        return null;
      }
    }

    async request(path, options = {}) {
      const headers = {
        apikey: this.key,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };
      if (options.auth !== false) {
        const session = await this.ensureSession();
        if (!session?.access_token) throw new Error("登录已过期，请重新登录");
        headers.Authorization = `Bearer ${session.access_token}`;
      }
      const response = await fetch(`${this.url}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
      }
      if (!response.ok) {
        const message = data?.msg || data?.message || data?.error_description || data?.hint || `云端请求失败（${response.status}）`;
        throw new Error(message);
      }
      return data;
    }

    async rest(table, options = {}) {
      const query = options.query ? `?${options.query}` : "";
      const headers = { ...(options.headers || {}) };
      if (options.prefer) headers.Prefer = options.prefer;
      return this.request(`/rest/v1/${table}${query}`, {
        method: options.method || "GET",
        body: options.body,
        headers,
      });
    }

    async fetchAll(table, select = "*", filters = "") {
      const rows = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const suffix = filters ? `&${filters}` : "";
        const page = await this.rest(table, {
          query: `select=${encodeURIComponent(select)}&limit=${pageSize}&offset=${offset}${suffix}`,
        });
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return rows;
    }

    async getOrCreateWorkspace() {
      const rows = await this.rest("workspaces", { query: "select=*&order=created_at.asc&limit=1" });
      if (rows.length) return rows[0];
      const created = await this.rest("workspaces", {
        method: "POST",
        prefer: "return=representation",
        body: { name: "缴费管理" },
      });
      return created[0];
    }

    async loadData(workspaceId) {
      const filter = `workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`;
      const [students, records] = await Promise.all([
        this.fetchAll("students", "*", filter),
        this.fetchAll("payment_records", "*", filter),
      ]);
      return { students, records };
    }

    async insertStudent(student) {
      const rows = await this.rest("students", {
        method: "POST",
        prefer: "return=representation",
        body: student,
      });
      return rows[0];
    }

    async insertPayment(record) {
      const rows = await this.rest("payment_records", {
        method: "POST",
        prefer: "return=representation",
        body: record,
      });
      return rows[0];
    }

    async updatePayment(id, patch) {
      const rows = await this.rest("payment_records", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(id)}`,
        prefer: "return=representation",
        body: patch,
      });
      return rows[0];
    }

    async workspaceVersion(id) {
      const rows = await this.rest("workspaces", {
        query: `id=eq.${encodeURIComponent(id)}&select=updated_at`,
      });
      return rows[0]?.updated_at || "";
    }

    async importData(workspaceId, payload, onProgress = () => {}) {
      if (!Array.isArray(payload.students) || !Array.isArray(payload.records)) throw new Error("导入文件格式不正确");
      const studentRows = payload.students.map((student) => ({
        workspace_id: workspaceId,
        legacy_id: student.id,
        name: student.name,
        subject: student.subject || "英语",
        status: student.status || "待确认",
        phone: student.phone || "",
        guardian: student.guardian || "",
        note: student.note || "",
        source_row: student.sourceRow || null,
        original_sequence: student.originalSequence || "",
        duplicate_name: Boolean(student.duplicateName),
        imported: true,
      }));
      const insertedStudents = [];
      for (let i = 0; i < studentRows.length; i += 150) {
        const batch = await this.rest("students", {
          method: "POST",
          query: "on_conflict=workspace_id,legacy_id",
          prefer: "resolution=merge-duplicates,return=representation",
          body: studentRows.slice(i, i + 150),
        });
        insertedStudents.push(...batch);
        onProgress(Math.min(35, Math.round((i + 150) / studentRows.length * 35)), "正在导入学员档案");
      }
      const idMap = new Map(insertedStudents.map((student) => [student.legacy_id, student.id]));
      if (idMap.size < studentRows.length) {
        const allStudents = await this.fetchAll("students", "id,legacy_id", `workspace_id=eq.${workspaceId}`);
        allStudents.forEach((student) => idMap.set(student.legacy_id, student.id));
      }
      const recordRows = payload.records.map((record) => ({
        workspace_id: workspaceId,
        student_id: idMap.get(record.studentId),
        legacy_id: record.id,
        student_name: record.studentName,
        subject: record.subject || "英语",
        term: record.term || "",
        amount: record.amount,
        payment_date: record.paymentDate || null,
        method: record.method || "未记录",
        kind: record.kind || "payment",
        status: record.status || "待核对",
        note: record.note || "",
        source: record.source || "",
        imported: true,
      })).filter((record) => record.student_id);
      for (let i = 0; i < recordRows.length; i += 150) {
        await this.rest("payment_records", {
          method: "POST",
          query: "on_conflict=workspace_id,legacy_id",
          prefer: "resolution=merge-duplicates,return=minimal",
          body: recordRows.slice(i, i + 150),
        });
        onProgress(35 + Math.min(65, Math.round((i + 150) / recordRows.length * 65)), "正在导入缴费记录");
      }
      return { students: studentRows.length, records: recordRows.length };
    }
  }

  window.CloudApi = CloudApi;
})();
