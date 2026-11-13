# Nítida — compartilhamento de tela com foco em qualidade

Plataforma web em **português**, com contas, acesso como convidado, amizades, pedidos de amizade, convites por link e pela lista de amigos, e compartilhamento de **tela e áudio opcional** via WebRTC. Sem chat, sem chamadas de voz, sem microfone e sem gravação.

## O que está pronto

- Registro com nome de usuário/e-mail/senha e login; sessão persistente por cookie `HttpOnly`; senha protegida com `scrypt` + salt aleatório.
- Acesso como convidado com nome opcional (convidados podem criar salas e assistir; não usam amizades).
- Adicionar pessoas pelo nome de usuário, aceitar/recusar/cancelar pedidos, remover amizades e presença online.
- Criar sala temporária, copiar link privado e convidar amigos online ou offline. Salas expiram **24 horas depois da criação**; criadores podem encerrá-las antes.
- Capturar janela, aba ou tela **com consentimento pelo seletor do navegador**, com opção de áudio do sistema/aba quando disponível.
- Perfis `480p30`, `720p30`, `720p60`, `1080p30`, `1080p60`.
- WebRTC P2P com limites solicitados de bitrate e FPS, estatísticas básicas da transmissão e ajuste de qualidade durante o compartilhamento (quando o navegador permitir).
- Uma tela ativa por sala, qualquer participante pode assumir quando ninguém está transmitindo.
- Layout escuro responsivo, projetado para visualizar em smartphones e usar no desktop.
- Banco de dados SQLite com integridade referencial e modo WAL.

## Pré-requisitos

- **Node.js 20 ou superior** (recomendado Node.js 22 LTS).
- Navegador atualizado no computador; recomendado Chrome/Edge para a melhor chance de áudio do computador.
- Para acessar pela internet: domínio, **HTTPS**, servidor com Node.js e servidor **TURN** para funcionar em redes restritas.

## Executar no computador

```bash
npm install
cp .env.example .env
npm run dev
```

No Windows (PowerShell), use `Copy-Item .env.example .env` em vez de `cp` se necessário. Abra **http://localhost:3000**.

1. Escolha **Convidado** ou **Criar conta**.
2. Clique em **Criar sala de transmissão**.
3. Configure resolução/FPS e marque **Áudio do computador** somente se desejar.
4. Clique em **Iniciar transmissão** e autorize a captura no navegador.
5. Copie o link e abra em outro navegador, computador ou perfil. O segundo participante pode entrar como convidado.
6. Para testar amizades, crie duas contas, adicione pela opção `@usuário`, aceite o pedido e use o botão de convite com a sala aberta.

**Importante:** computadores e celulares fora do `localhost` exigem HTTPS para captura de tela; sem HTTPS o navegador pode bloquear a API. O telefone normalmente é mais útil **para assistir**, não para transmitir a própria tela.

## Como funciona

```
Navegador A ── HTTPS/WebSocket ──► Node.js + Socket.IO ──► SQLite
      │                                  │
      └──────── WebRTC (DTLS-SRTP) ◄─────┘ apenas sinalização
      │
      └────────────── tela/áudio ──────────────► Navegador B
                          └───────────────────► Navegador C
```

O servidor mantém as contas, permissões, convites, presença e sinalização WebRTC. **Vídeo e áudio não passam pelo servidor de sinalização** em conexão P2P comum; quando necessário, trafegam por servidor TURN. O navegador negocia codecs e protege a mídia em trânsito com WebRTC.

### Qualidade dos perfis

| Perfil | Resolução solicitada | FPS solicitados | Teto de bitrate de vídeo |
|---|---|---|---|
| 480p30 | 854 × 480 | 30 | 1,8 Mb/s |
| 720p30 | 1280 × 720 | 30 | 4 Mb/s |
| 720p60 | 1280 × 720 | 60 | 6 Mb/s |
| 1080p30 | 1920 × 1080 | 30 | 8 Mb/s |
| 1080p60 | 1920 × 1080 | 60 | 12 Mb/s |

Esses valores são **solicitações e limites máximos**, não garantias. A resolução e a taxa real dependem da tela compartilhada, codec, navegador, GPU, velocidade de upload e rede. O bitrate é um *teto*, e não uma taxa obrigatória. Se a tela original for menor que 1080p, a plataforma não inventará pixels. A taxa indicada na interface é calculada pelos contadores WebRTC, quando disponíveis.

**Áudio**: o navegador pode oferecer áudio de uma aba, janela ou de todo o sistema, dependendo do sistema operacional e da versão. Mesmo com a caixa marcada, o retorno pode não conter áudio. Não existe captura de microfone neste projeto. O espectador deve clicar em **Ativar áudio da transmissão** quando o navegador impedir o autoplay com som.

### Limite de participantes

Por padrão, **4 participantes por sala** (1 pessoa transmitindo para até 3 espectadores). O WebRTC atual é do tipo **mesh/P2P**: cada espectador adicional requer mais uma conexão e mais upload do transmissor. Por exemplo, três espectadores recebendo até 12 Mb/s podem exigir **até ~36 Mb/s de upload de vídeo**, além de sobrecarga e áudio. Este projeto foi pensado para grupos pequenos e qualidade, não distribuição massiva.

Para grupos maiores e 1080p60 constante, o próximo passo técnico é um **SFU** (por exemplo, mediasoup ou LiveKit), além de controle de congestionamento, adaptação de bitrate e capacidade de rede suficiente.

## Configuração e produção

As variáveis estão em `.env.example`:

- `PORT=3000` — porta HTTP do servidor.
- `NODE_ENV=production` — cookies `Secure` e ajustes para produção. **Só use com HTTPS** em proxy reverso.
- `APP_ORIGIN=https://seudominio.com` — origem exata permitida para operações autenticadas.
- `DB_FILE=./data/nitida.sqlite` — local do banco persistente (não coloque em `/public`).
- `MAX_ROOM_PARTICIPANTS=4` — limite de pessoas por sala (mínimo 2, máximo 12; elevar exige mais upload).
- `STUN_URL` — servidor STUN.
- `TURN_URL` — URL de seu servidor TURN, por exemplo `turn:turn.seudominio.com:3478?transport=udp`.
- `TURN_USERNAME` e `TURN_CREDENTIAL` — credenciais TURN.

Sem TURN, parte dos pares poderá conectar com STUN, mas outros não (NAT simétrico, Wi-Fi corporativo, redes móveis restritas). Para produção, **configure TURN** (por exemplo, coturn) com TLS/credenciais apropriadas e regras contra abuso. Credenciais estáticas presentes em `/api/config` são visíveis aos clientes; em produção de grande escala, substitua por credenciais TURN de curta duração fornecidas pelo backend. **Não confunda credenciais TURN com senhas dos usuários**.

### Docker (opcional)

```bash
docker compose up --build -d
```

A aplicação ficará em `http://localhost:3000`. Para publicar, coloque atrás de um reverse proxy HTTPS que aceite WebSocket, configure o domínio em `APP_ORIGIN`, mantenha o volume `nitida_data` e configure TURN. Não publique a porta do SQLite nem adicione seu arquivo ao Git.

## Segurança e limitações desta versão

- Qualquer pessoa que **obtiver o link** pode entrar, inclusive convidada. O link é longo e imprevisível, mas não há senha por sala nem aprovação manual de espectadores nesta versão.
- A aplicação **não grava** nem armazena áudio/vídeo; o navegador sempre pede permissão para escolher a área capturada.
- Senhas usam `scrypt` com sal aleatório; cookies são `HttpOnly`, `SameSite=Lax` e `Secure` em produção; alteração de estado verifica `Origin`; endpoints sensíveis têm limitador de requisições; acesso às salas e encaminhamento dos sinais são validados pelo servidor.
- Sessões duram até 30 dias. Convidados também recebem cookie para permanecer conectados até saírem.
- Somente **uma tela por sala** por vez; não há chat, câmera, compartilhamento de microfone, gravação, comentários, notificações push ou recuperação de senha por e-mail.
- Banco SQLite e presença de sockets em memória funcionam bem em **uma instância** do backend. Para alta disponibilidade/múltiplas instâncias, seria preciso adaptar o armazenamento das presenças, o adaptador Socket.IO e o banco.
- Nenhuma ferramenta web consegue forçar 1080p60 constante em todos os sistemas. Para validar a qualidade, teste com a combinação de navegador, hardware e conexão de destino.

## Testes automatizados

```bash
npm test
```

O teste de integração cria banco temporário, registra contas e convidados, envia e aceita pedido de amizade, cria sala e verifica convite. O teste usa a porta aleatória local do Node.

## Estrutura

```text
nitida-share/
  server/
    index.js         API REST, autenticação, sinalização e salas
    db.js            Esquema e consultas SQLite
  public/
    index.html       Interface
    styles.css       Layout responsivo
    app.js           Tela, WebRTC, amizades e salas
    favicon.svg
  tests/
    api.test.js      Teste de integração
  .env.example
  Dockerfile
  compose.yaml
  package.json
```

### Fontes técnicas oficiais

- MDN — [Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- MDN — [RTCRtpSender.setParameters](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- MDN — [WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
