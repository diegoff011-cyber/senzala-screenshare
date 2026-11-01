# Configurar TURN (resolve "conecta mas a tela fica preta")

Sem TURN, dois PCs atrás de roteadores/operadoras restritas (CGNAT é comum no Brasil) não
conseguem abrir caminho direto. O TURN faz a tela passar por um servidor de apoio.

## Opção A - Metered (plano gratuito)
1. Crie uma conta em metered.ca e um app TURN.
2. No Render > seu serviço > Environment, adicione:
   - METERED_DOMAIN = seuapp.metered.live
   - METERED_API_KEY = (a chave da API do painel do Metered)
3. Faça o deploy. No log deve aparecer "TURN carregado".

## Opção B - qualquer outro TURN
Defina ICE_SERVERS no Render com um JSON, por exemplo:
[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:SEU-HOST:3478","username":"USUARIO","credential":"SENHA"}]
