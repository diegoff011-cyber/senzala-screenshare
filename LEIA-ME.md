# Senzala Screenshare

Acesso remoto entre PCs, no estilo AnyDesk. Cada PC tem um código; quem quer acessar digita o código
e o dono do PC aceita (ou recusa) o pedido.

## O que tem aqui
- `servidor/`  -> sobe no Render (só apresenta os PCs um ao outro; não vê a tela de ninguém)
- `app/`       -> o programa do Windows (Electron)

## Passo a passo
1. Suba esta pasta inteira num repositório novo do GitHub (ex.: `senzala-screenshare`).
2. No Render: New + > Web Service > escolha o repositório.
   - Root Directory: `servidor`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
3. Quando o Render terminar, copie o endereço (ex.: `https://senzala-screenshare.onrender.com`).
4. Abra `app/config.json` e troque o endereço, usando `wss://` no lugar de `https://`:
   `{ "servidor": "wss://senzala-screenshare.onrender.com" }`
5. Na pasta `app`, abra o terminal e rode:
   - `npm install`
   - `npm start`   (para testar)
   - `npm run dist` (gera o instalador em `app/dist/`)
6. Instale nos dois PCs, abra, e teste: digite o código de um PC no outro.

## Observações
- No plano grátis do Render o servidor "dorme" depois de um tempo parado. A primeira conexão do dia
  pode demorar até 1 minuto.
- Se alguma rede bloquear a conexão direta, é preciso um servidor TURN. Coloque no Render a variável
  `ICE_SERVERS` com algo como:
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:SEU-TURN:3478","username":"usuario","credential":"senha"}]`
- Controle de mouse/teclado funciona no Windows. Programas abertos "como administrador" no PC remoto
  só aceitam controle se o Senzala Screenshare também for aberto como administrador.
- Para testar duas cópias no mesmo PC: `set SENZALA_DEV=2` e depois `npm start` numa segunda janela do terminal.
