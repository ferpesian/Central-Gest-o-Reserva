/* Camada de compatibilidade: oferece ao app a mesma interface `claude.use(...)`
   que ele tinha dentro do Claude, agora sobre Supabase (banco + login),
   Google Drive (envio de PDF), ditado do navegador e download local. */
(function () {
  const CFG = window.CENTRAL_CONFIG || {};
  const pendSenha = /type=(invite|recovery|signup)/.test(location.hash) ? (location.hash.includes('invite')||location.hash.includes('signup') ? 'invite' : 'recovery') : null;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.sbClient = sb;
  const state = { user: null, perfil: null };
  window.centralState = state;
  const isAdmin = () => state.perfil && state.perfil.papel === 'admin';
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  /* ---------- banco: tabela única `registros` (col, id, data, owner) ---------- */
  // Diário é pessoal: para quem não é admin, o id fica "data@usuario".
  const ownDiary = c => c === 'diario' && !isAdmin();
  const mapIn = (c, id) => (ownDiary(c) ? id + '@' + state.user.id : id);
  async function fetchAll(c) {
    let out = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from('registros').select('id,data,owner,updated_at').eq('col', c).range(from, from + 999);
      if (error) throw err('db_error', error.message);
      out = out.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    if (c === 'diario') {
      const suf = '@' + state.user.id;
      out = isAdmin() ? out.filter(r => !r.id.includes('@')) : out.filter(r => r.id.endsWith(suf)).map(r => ({ ...r, id: r.id.slice(0, -suf.length) }));
    }
    return out;
  }
  const snap = rows => ({
    metadata: { fromCache: false },
    docs: rows.map(r => ({ id: r.id, data: () => ({ ...r.data, _owner: r.owner, _upd: r.updated_at }) }))
  });
  const clean = d => { const o = {}; for (const k in d) if (!k.startsWith('_')) o[k] = d[k]; return o; };
  const db = {
    collection(c) {
      return {
        onSnapshot(cb, onErr) {
          let t = null, alive = true;
          const load = () => fetchAll(c).then(rows => alive && cb(snap(rows))).catch(e => onErr && onErr(e));
          load();
          const ch = sb.channel('reg-' + c + '-' + Math.random().toString(36).slice(2))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'registros', filter: 'col=eq.' + c }, () => { clearTimeout(t); t = setTimeout(load, 250); })
            .subscribe();
          return () => { alive = false; sb.removeChannel(ch); };
        },
        doc(id) {
          return {
            async set(data) {
              const { error } = await sb.from('registros').upsert({ col: c, id: mapIn(c, id), data: clean(data) }, { onConflict: 'col,id' });
              if (error) throw err(/row-level security|permission/i.test(error.message) ? 'forbidden' : 'db_error', /row-level security|permission/i.test(error.message) ? 'Você só pode editar os seus próprios registros.' : error.message);
            },
            async delete() {
              const { error, count } = await sb.from('registros').delete({ count: 'exact' }).eq('col', c).eq('id', mapIn(c, id));
              if (error) throw err('db_error', error.message);
              if (count === 0) throw err('forbidden', 'Você só pode excluir os seus próprios registros.');
            }
          };
        }
      };
    }
  };

  /* importação em lote (backup do Claude e análise semanal do CRM) — só admin */
  window.centralImport = async function (col, docs, opts = {}) {
    if (!isAdmin()) throw err('forbidden', 'Só o administrador importa dados');
    if (opts.replace) {
      const { error } = await sb.from('registros').delete().eq('col', col);
      if (error) throw err('db_error', error.message);
    }
    const rows = docs.map(d => { const { id, ...rest } = d; return { col, id: String(id), data: clean(rest) }; });
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await sb.from('registros').upsert(rows.slice(i, i + 400), { onConflict: 'col,id' });
      if (error) throw err('db_error', error.message);
    }
    return rows.length;
  };
  window.centralDelete = async function (col, ids) {
    if (!isAdmin()) throw err('forbidden', 'Só o administrador');
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await sb.from('registros').delete().eq('col', col).in('id', ids.slice(i, i + 200));
      if (error) throw err('db_error', error.message);
    }
  };

  /* ---------- download ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  };

  /* ---------- Google Drive (envio de PDF para a pasta da Reserva) ---------- */
  let gToken = null, gExp = 0;
  function driveToken() {
    return new Promise((res, rej) => {
      if (!CFG.GOOGLE_CLIENT_ID) return rej(err('server_not_connected'));
      if (gToken && Date.now() < gExp) return res(gToken);
      if (!window.google || !google.accounts || !google.accounts.oauth2) return rej(err('server_not_connected', 'Biblioteca do Google não carregou'));
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive',
        callback: r => { if (r.error) return rej(err('needs_reauth', r.error)); gToken = r.access_token; gExp = Date.now() + (r.expires_in - 60) * 1000; res(gToken); }
      });
      tc.requestAccessToken({ prompt: gToken ? '' : 'consent' });
    });
  }
  const mcp = {
    async callTool(server, tool, a) {
      if (tool !== 'create_file') throw err('not_in_manifest');
      const tok = await driveToken();
      const meta = { name: a.title, mimeType: a.contentMimeType, parents: a.parentId ? [a.parentId] : undefined };
      const bin = atob(a.base64Content), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      fd.append('file', new Blob([u8], { type: a.contentMimeType }));
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
      if (r.status === 401) { gToken = null; throw err('needs_reauth'); }
      const j = await r.json();
      if (!r.ok) throw err('tool_error', (j.error && j.error.message) || 'erro ' + r.status);
      return { payload: { viewUrl: j.webViewLink, id: j.id } };
    }
  };

  /* ---------- ditado (Chrome/Edge) ---------- */
  function makeDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let rec = null, fin = () => {}, par = () => {}, st = () => {};
    return {
      onFinal(f) { fin = f; }, onPartial(f) { par = f; }, onState(f) { st = f; },
      start({ language } = {}) {
        return new Promise((res, rej) => {
          rec = new SR(); rec.lang = language || 'pt-BR'; rec.continuous = true; rec.interimResults = true;
          rec.onstart = () => { st({ state: 'listening' }); res(); };
          rec.onresult = e => { let p = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin({ text: t + ' ' }); else p += t; } par({ text: p }); };
          rec.onerror = e => { const reason = e.error === 'not-allowed' ? 'not_granted' : e.error; st({ state: 'idle', reason }); if (e.error === 'not-allowed') rej(err('not_granted')); };
          rec.onend = () => st({ state: 'idle' });
          try { rec.start(); } catch (e) { rej(err('unavailable')); }
        });
      },
      stop() { if (rec) { st({ state: 'finishing' }); rec.stop(); } return Promise.resolve(); }
    };
  }

  /* ---------- usuário ---------- */
  const user = {
    async isOwner() { return isAdmin(); },
    async id() { return state.user && state.user.id; },
    async name() { return state.perfil && state.perfil.nome; }
  };

  window.claude = {
    use(n) {
      if (n === 'db') return Promise.resolve(db);
      if (n === 'downloads') return Promise.resolve(downloads);
      if (n === 'mcp') return Promise.resolve(mcp);
      if (n === 'user') return Promise.resolve(user);
      if (n === 'dictation') { const d = makeDictation(); return d ? Promise.resolve(d) : Promise.reject(err('unavailable')); }
      return Promise.reject(err('unavailable'));
    }
  };

  /* ---------- login ---------- */
  async function loadPerfil() {
    const { data } = await sb.from('perfis').select('id,nome,papel,email,corretor,ativo').eq('id', state.user.id).maybeSingle();
    state.perfil = data && data.ativo === false ? null : data;
    const { data: all } = await sb.from('perfis').select('id,nome,papel');
    state.perfis = all || [];
  }
  window.centralAuth = {
    async start(onReady) {
      const box = document.getElementById('login');
      const askPass = (tipo) => new Promise(res => {
        const f = box.querySelector('form'); const msg = box.querySelector('#lgMsg');
        box.style.display = 'grid';
        f.innerHTML = '<div class="logo" style="color:#fff">R</div><h2>' + (tipo === 'invite' ? 'Bem-vindo! Crie sua senha' : 'Crie uma nova senha') + '</h2><div class="mute sm">' + (state.user.email || '') + '</div>' +
          '<label for="np1">Nova senha (mínimo 8 caracteres)</label><input id="np1" type="password" autocomplete="new-password" minlength="8" required>' +
          '<label for="np2">Repita a senha</label><input id="np2" type="password" autocomplete="new-password" minlength="8" required>' +
          '<button type="submit">Salvar senha e entrar</button><p id="lgMsg" class="sm" style="color:var(--red);min-height:1em"></p>';
        f.onsubmit = async e => {
          e.preventDefault(); const m = f.querySelector('#lgMsg');
          const a = f.querySelector('#np1').value, b = f.querySelector('#np2').value;
          if (a.length < 8) { m.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
          if (a !== b) { m.textContent = 'As senhas não são iguais.'; return; }
          m.textContent = 'Salvando…';
          const { error } = await sb.auth.updateUser({ password: a });
          if (error) { m.textContent = 'Não foi possível salvar a senha. Tente de novo.'; return; }
          history.replaceState(null, '', location.pathname); res();
        };
      });
      let pend = pendSenha;
      window.__centralPendSenha = t => { pend = t; };
      const go = async session => {
        state.user = session.user;
        if (pend) { const t = pend; pend = null; await askPass(t); }
        await loadPerfil();
        if (!state.perfil) { box.querySelector('#lgMsg').textContent = 'Seu acesso não está liberado ou foi desativado. Fale com o Fernando.'; box.style.display = 'grid'; return; }
        box.style.display = 'none'; onReady(state);
      };
      const { data: { session } } = await sb.auth.getSession();
      if (session) return go(session);
      box.style.display = 'grid';
      box.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const msg = box.querySelector('#lgMsg'); msg.textContent = 'Entrando…';
        const { data, error } = await sb.auth.signInWithPassword({ email: box.querySelector('#lgEmail').value.trim(), password: box.querySelector('#lgPass').value });
        if (error) { msg.textContent = 'E-mail ou senha incorretos.'; return; }
        msg.textContent = ''; go(data.session);
      };
      box.querySelector('#lgForgot').onclick = async () => {
        const email = box.querySelector('#lgEmail').value.trim();
        const msg = box.querySelector('#lgMsg');
        if (!email) { msg.textContent = 'Digite o seu e-mail primeiro.'; return; }
        await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        msg.textContent = 'Se o e-mail estiver cadastrado, você vai receber o link para criar uma nova senha.';
      };
    },
    async logout() { await sb.auth.signOut(); location.reload(); }
  };
  // link de redefinição de senha
  sb.auth.onAuthStateChange(async (ev) => {
    if (ev === 'PASSWORD_RECOVERY' && window.__centralPendSenha) window.__centralPendSenha('recovery');
  });
})();
