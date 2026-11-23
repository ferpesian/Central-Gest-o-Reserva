// Administração de usuários da Central da Gestão (só o admin chama).
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://central-gestao-reserva.vercel.app";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const adm = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ erro: "Sessão inválida" }, 401);
    const { data: eu } = await adm.from("perfis").select("papel,ativo").eq("id", user.id).maybeSingle();
    if (!eu || eu.papel !== "admin" || !eu.ativo) return json({ erro: "Só o administrador pode gerenciar usuários" }, 403);

    const b = await req.json().catch(() => ({}));
    const acao = b.acao;

    if (acao === "listar") {
      const { data: perfis } = await adm.from("perfis").select("id,nome,email,papel,corretor,ativo,criado_em");
      const { data: lu } = await adm.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const m = new Map((lu?.users ?? []).map((u) => [u.id, u]));
      return json({ usuarios: (perfis ?? []).map((p) => { const u = m.get(p.id); return { ...p, ultimoAcesso: u?.last_sign_in_at ?? null, senhaCriada: !!u?.last_sign_in_at }; }) });
    }

    const papelOk = (p: string) => p === "gestor" || p === "corretor";

    if (acao === "criar") {
      const email = String(b.email ?? "").trim().toLowerCase();
      const nome = String(b.nome ?? "").trim();
      const papel = String(b.papel ?? "");
      const corretor = papel === "corretor" ? String(b.corretor ?? "").trim() : null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nome) return json({ erro: "Informe nome e e-mail válidos" }, 400);
      if (!papelOk(papel)) return json({ erro: "Papel inválido" }, 400);
      if (papel === "corretor" && !corretor) return json({ erro: "Escolha a qual corretor esse acesso pertence" }, 400);
      let uid: string | undefined, link: string | undefined;
      if (b.enviarEmail) {
        const { data, error } = await adm.auth.admin.inviteUserByEmail(email, { redirectTo: SITE });
        if (error) return json({ erro: /already/i.test(error.message) ? "Esse e-mail já tem acesso. Use 'Gerar link'." : /rate/i.test(error.message) ? "Limite de e-mails do Supabase atingido (2 por hora). Use 'Gerar link' e mande pelo WhatsApp." : error.message }, 400);
        uid = data.user?.id;
      } else {
        const { data, error } = await adm.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: SITE } });
        if (error) return json({ erro: /already/i.test(error.message) ? "Esse e-mail já tem acesso. Use 'Gerar link'." : error.message }, 400);
        uid = data.user?.id; link = data.properties?.action_link;
      }
      if (!uid) return json({ erro: "Não foi possível criar o usuário" }, 500);
      const { error: pe } = await adm.from("perfis").upsert({ id: uid, nome, email, papel, corretor, ativo: true }, { onConflict: "id" });
      if (pe) return json({ erro: pe.message }, 500);
      return json({ ok: true, link: link ?? null });
    }

    const id = String(b.id ?? "");
    const { data: alvo } = await adm.from("perfis").select("id,email,papel").eq("id", id).maybeSingle();
    if (!alvo) return json({ erro: "Usuário não encontrado" }, 404);
    if (alvo.papel === "admin" && acao !== "link") return json({ erro: "O acesso do administrador não pode ser alterado por aqui" }, 400);

    if (acao === "link") {
      const { data, error } = await adm.auth.admin.generateLink({ type: "recovery", email: alvo.email, options: { redirectTo: SITE } });
      if (error) return json({ erro: error.message }, 400);
      return json({ ok: true, link: data.properties?.action_link });
    }
    if (acao === "atualizar") {
      const up: Record<string, unknown> = {};
      if (b.nome) up.nome = String(b.nome).trim();
      if (b.papel) { if (!papelOk(b.papel)) return json({ erro: "Papel inválido" }, 400); up.papel = b.papel; }
      if ("corretor" in b) up.corretor = (b.papel ?? alvo.papel) === "corretor" ? String(b.corretor || "") || null : null;
      if (typeof b.ativo === "boolean") {
        up.ativo = b.ativo;
        await adm.auth.admin.updateUserById(id, { ban_duration: b.ativo ? "none" : "876000h" });
      }
      const { error } = await adm.from("perfis").update(up).eq("id", id);
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }
    if (acao === "excluir") {
      const { error } = await adm.auth.admin.deleteUser(id);
      if (error) return json({ erro: error.message }, 400);
      return json({ ok: true });
    }
    return json({ erro: "Ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
