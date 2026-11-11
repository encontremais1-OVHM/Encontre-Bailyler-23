# Encontre Mais — WhatsApp Web Community API

Serviço independente para ligar uma conta WhatsApp ao WhatsApp Web através de **Baileys** (API não oficial). Não utiliza Meta Cloud API.

## Âmbito da integração
A API fornece a ligação WhatsApp e as operações técnicas usadas pelo painel Super Admin:
- iniciar sessão, consultar estado, obter QR e código de emparelhamento, terminar sessão;
- descobrir as Comunidades WhatsApp da conta ligada e os grupos internos associados;
- consultar participantes, ligações de convite e imagens dos grupos;
- adicionar/remover participantes na comunidade e nos subgrupos, exigindo que a conta ligada seja administradora;
- enviar mensagens de notificação.

A API não cria grupos e não decide assinaturas, pagamentos ou elegibilidade. Essas regras continuam no backend da plataforma e no Supabase. Apenas administradores podem criar/gerir grupos no WhatsApp.

## Stack
- Node.js 22 + TypeScript + Express
- `@whiskeysockets/baileys@6.7.24`
- QR Code / pairing code
- Sessão persistente em volume Railway: `/data/whatsapp-auth`
- Supabase externo para guardar eventos de ligação e de participantes
- API key de servidor em `x-api-key`

## Endpoints
Todas as rotas `/v1/*` exigem `x-api-key`.

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/health` | Healthcheck |
| GET | `/v1/session` | Estado da sessão |
| POST | `/v1/session/connect` | Iniciar ligação |
| GET | `/v1/session/qr` | Obter QR em texto e Data URL |
| POST | `/v1/session/pairing-code` | Pedir código de associação |
| POST | `/v1/session/logout` | Terminar sessão |
| GET | `/v1/community` | Verificar a comunidade principal configurada |
| GET | `/v1/communities` | Descobrir comunidades e subgrupos da conta ligada |
| GET | `/v1/groups/:jid/participants` | Consultar participantes |
| POST | `/v1/groups/:jid/participants/add` | Submeter entrada num grupo/comunidade |
| POST | `/v1/groups/:jid/participants/remove` | Submeter remoção de um grupo/comunidade |
| GET | `/v1/groups/:jid/invite-link` | Obter ligação de convite |
| GET | `/v1/groups/:jid/profile-picture` | Obter imagem do grupo |
| POST | `/v1/messages/send` | Enviar mensagem WhatsApp |

Exemplo de corpo para adicionar/remover: `{"phoneNumber":"+2449XXXXXXXX"}`.

## Implementação específica de comunidades
A API usa o protocolo interno WhatsApp Web de comunidades (`w:g2`) através do socket Baileys, porque a API pública estável do Baileys 6.x não oferece métodos tipados de comunidade. Este protocolo não é documentado nem garantido: mudanças no WhatsApp podem exigir manutenção. Por isso o CI prova apenas compilação; a operação real só pode ser aprovada depois de emparelhar uma conta de teste e executar add/remove numa comunidade de teste.

## Regras de segurança e confirmação
- O serviço só opera no JID fixado em `COMMUNITY_JID`; o cliente não pode escolher outro grupo.
- Antes da alteração, consulta os metadados e exige que a comunidade seja reconhecida como comunidade.
- Confirma que a conta WhatsApp ligada é administradora da comunidade.
- Valida se o número existe no WhatsApp e verifica se já é membro/não é membro.
- O resultado da chamada de adição/remoção é apenas uma operação submetida. **Nunca ativa nem termina uma assinatura por si só.**
- A privacidade do destinatário e as regras do WhatsApp podem impedir a inclusão direta; o serviço não transforma uma resposta de convite/recusa em adesão confirmada.
- A remoção da comunidade pede também remoção dos grupos ligados (`linked_groups=true`), conforme o protocolo WhatsApp Web.
- Os eventos reais `group.participants.update` são assinados com HMAC e enviados para a Edge Function `whatsapp-confirmation`; a função valida a assinatura e confirma a adesão/remoção no Supabase.
- Uma resposta HTTP de sucesso da operação nunca altera por si só o estado `joined`; a confirmação depende do evento real ou de reconciliação por snapshot.
- A aplicação deve validar número, inscrição, assinatura, carência e grupo antes de atualizar o estado do membro.
- A API key e a service-role key nunca podem ir para o browser. O frontend deverá chamar uma Supabase Edge Function/backend que autentique o utilizador e autorize a operação.

## Variáveis de ambiente
Copiar `.env.example`:
- `PORT`
- `SERVICE_API_KEY` — mínimo 32 caracteres aleatórios
- `AUTH_DIR=/data/whatsapp-auth`
- `COMMUNITY_JID` — ID WhatsApp da comunidade principal, formato `...@g.us`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- A tabela antiga `whatsapp_web_events` já não é usada por esta versão; os eventos seguem para a Edge Function existente `whatsapp-confirmation`.

Aplicar manualmente `supabase/whatsapp-web-events.sql` no projeto Supabase externo depois de rever. Não altera tabelas de membros ou assinaturas.

## Railway
1. Criar um serviço novo ligado a este repositório e branch `main`.
2. Criar um Volume montado em `/data` (obrigatório para persistir a sessão).
3. Definir todas as variáveis de ambiente.
4. Healthcheck: `/health`.
5. Manter apenas uma réplica (uma sessão WhatsApp por volume).
6. Fazer deploy e emparelhar pelo QR ou código.
7. Confirmar que a sessão continua ligada depois de restart.

## Testes obrigatórios antes de desligar o servidor antigo
- CI: instalação, typecheck e build aprovados.
- Conta ligada corresponde ao número administrador esperado.
- `GET /v1/community` identifica a comunidade principal e confirma que a conta é admin.
- Teste de adicionar um número de teste e observar evento real de entrada.
- Teste de remover o mesmo número e observar evento real de saída.
- Testar números que já são membros, números inválidos, conta sem admin e sessão desligada.
- Verificar persistência dos eventos no Supabase.
- Só depois ligar o frontend através de uma Edge Function e fazer testes de ponta a ponta.
- Não pausar o servidor antigo até todos os testes passarem.

## Aviso
Baileys é uma biblioteca não oficial, sem afiliação ou suporte do WhatsApp. Mudanças no protocolo podem interromper o serviço e a automação pode expor a conta a restrições. A entrada direta pode ser recusada pelas configurações de privacidade do utilizador ou por limitações do WhatsApp; o serviço devolve o resultado da operação e não finge que a adesão foi concluída.

Boiler inicial. Build, deploy, emparelhamento e operações reais ainda precisam ser testados.
