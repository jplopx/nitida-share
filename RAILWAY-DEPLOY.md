# Nítida — deploy rápido no Railway

1. Suba todos os arquivos desta pasta para um repositório no GitHub, sem pasta `node_modules` e sem `data`.
2. Entre em https://railway.com/new e escolha **Deploy from GitHub repo**.
3. Selecione o repositório; o Railway detecta o `Dockerfile`.
4. Crie um **Volume** associado ao serviço e monte em `/app/data`.
5. Em Variables defina: `NODE_ENV=production`, `DB_FILE=/app/data/nitida.sqlite` e `MAX_ROOM_PARTICIPANTS=4`. Não defina `APP_ORIGIN` até ter domínio público; a aplicação usa o endereço da requisição como padrão.
6. Em Settings → Networking → Public Networking, clique em **Generate Domain**.
7. Abra o endereço HTTPS público, entre como convidado e crie sala; teste com segundo navegador, conta separada e link de convite.

Atenção: WebRTC P2P não funciona para todos os pares de redes somente com STUN; para maior confiabilidade, configure TURN_URL, TURN_USERNAME e TURN_CREDENTIAL com fornecedor TURN. Em Wi-Fi de faculdade redes podem bloquear P2P.

Recomendação para demonstração: mantenha 2 participantes, comece em 720p30 e teste vídeo/áudio; aumente para 1080p60 após confirmar banda suficiente. O Dockerfile roda como root para compatibilidade imediata com volumes root-owned do Railway; endureça permissões/usuário antes de uso público continuado. Um único servidor e uma única réplica são necessários para os mapas em memória de salas e presença funcionarem corretamente.
