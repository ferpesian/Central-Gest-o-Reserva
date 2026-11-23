# Central da Gestão — Reserva Imob BC

App web da gestão comercial (tarefas, diário, cobranças, corretores, 1:1, CRM, vendas, empresa), com login e banco no Supabase, código no GitHub e hospedagem gratuita na Vercel.

## Quem acessa e o que pode
| Usuário | Vê | Edita |
|---|---|---|
| Fernando (admin) | tudo | tudo, inclusive importar dados |
| Luiz | tudo | só os registros que ele mesmo criou |
| Alan | tudo | só os registros que ele mesmo criou |

As regras ficam no banco (RLS), não só na tela. O diário é pessoal: cada um tem o seu.
O código só é alterado por quem tem acesso ao repositório (Fernando, e o Claude a pedido dele).

## Colocar no ar (uma vez)
1. **Supabase** (supabase.com, plano gratuito): New project → nome `central-gestao` → região São Paulo.
   - SQL Editor → New query → cole `supabase/schema.sql` → Run.
   - Authentication → Providers → Email: desligue "Allow new users to sign up" (só quem você cadastrar entra).
   - Authentication → Users → Add user → Create new user, para cada um: Fernando, Luiz e Alan (e-mail + senha provisória, marque "Auto Confirm User"). Se os e-mails não forem `fernando@`, `luiz@` e `alan@reservaimob.com.br`, ajuste os e-mails no `schema.sql` antes de rodar (o admin é definido pelo e-mail do Fernando).
   - Settings → API: copie **Project URL** e **anon public key** para `js/config.js`.
   - Authentication → URL Configuration: Site URL = endereço da Vercel (passo 3).
2. **GitHub**: repositório privado `central-gestao-reserva` com estes arquivos.
3. **Vercel** (vercel.com, plano gratuito, entrar com o GitHub): Add New → Project → importar o repositório → Deploy (sem build). O endereço fica `central-gestao-reserva.vercel.app`.
4. **Dados atuais**: no painel antigo do Claude, aba Empresa → **Backup JSON**. No app novo, entrar como Fernando → aba Empresa → **Importar backup** → escolher o arquivo.

## Google Drive (opcional, para "Enviar ao Drive")
console.cloud.google.com → novo projeto → ativar **Google Drive API** → Tela de consentimento OAuth (Externo, modo Teste, adicionar os e-mails de Fernando, Luiz e Alan como usuários de teste) → Credenciais → ID do cliente OAuth → Aplicativo da Web → origem autorizada = endereço da Vercel. Colar o Client ID em `js/config.js` (`GOOGLE_CLIENT_ID`). Os PDFs vão para as mesmas pastas da Reserva de hoje (pasta da gestão e pasta de cada corretor).

## Estrutura
- `index.html` — o app (mesma interface do painel do Claude).
- `js/shim.js` — conexão com Supabase, login, Drive, ditado e download.
- `js/config.js` — chaves do projeto.
- `supabase/schema.sql` — tabelas, permissões (RLS) e tempo real.

## Análise semanal do CRM
A rotina de segunda grava no app pelo navegador do Fernando logado: `centralImport(colecao, documentos, {replace:true})` e `centralDelete(colecao, ids)`, funções disponíveis só para o admin.
