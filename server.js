const express = require('express');
const path = require('path');

const ipWhitelist = require('./middleware/ipWhitelist');
const moviesRouter = require('./routes/movies');

const app = express();
const PORT = process.env.PORT || 3000;

// Camada de acesso: aplica o whitelist de IP em TODAS as rotas,
// inclusive antes dos arquivos estáticos (HTML/CSS/JS).
app.use(ipWhitelist);

// Serve o frontend (catálogo e player)
app.use(express.static(path.join(__dirname, 'public')));

// Serve as capas dos filmes
app.use('/covers', express.static(path.join(__dirname, 'media', 'covers')));

// Rotas da API de catálogo e do streaming de vídeo
app.use('/', moviesRouter);

app.listen(PORT, () => {
  console.log(`Servidor de streaming rodando na porta ${PORT}`);
  console.log(`Acesse via http://<ip-do-servidor>:${PORT}`);
});
