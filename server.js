const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Chess } = require('chess.js');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Хранилище игр
const games = new Map();

// Генерация ID игры
function generateGameId() {
  return crypto.randomBytes(4).toString('hex');
}

// Создание новой игры
function createNewGame() {
  const gameId = generateGameId();
  const chess = new Chess();
  
  const game = {
    id: gameId,
    chess,
    players: {},
    status: 'waiting',
    turn: 'w',
    createdAt: new Date(),
    moves: []
  };
  
  games.set(gameId, game);
  
  // Автоматическое удаление игры через 24 часа
  setTimeout(() => {
    games.delete(gameId);
  }, 24 * 60 * 60 * 1000);
  
  return gameId;
}

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

  // Создание новой игры
  socket.on('create_game', (callback) => {
    const gameId = createNewGame();
    const game = games.get(gameId);
    
    callback({
      gameId,
      url: `http://localhost:${PORT}/game/${gameId}`
    });
  });

  // Присоединение к игре
  socket.on('join_game', ({ gameId, username }) => {
    const game = games.get(gameId);
    
    if (!game) {
      socket.emit('error', 'Игра не найдена');
      return;
    }
    
    if (Object.keys(game.players).length >= 2) {
      socket.emit('error', 'В игре уже два игрока');
      return;
    }
    
    // Определяем цвет игрока
    let playerColor;
    if (!game.players.white) {
      playerColor = 'white';
      game.players.white = { id: socket.id, username };
    } else if (!game.players.black) {
      playerColor = 'black';
      game.players.black = { id: socket.id, username };
    } else {
      socket.emit('error', 'Игра уже полная');
      return;
    }
    
    // Сохраняем информацию о сокете
    socket.gameId = gameId;
    socket.playerColor = playerColor;
    
    // Присоединяем сокет к комнате игры
    socket.join(gameId);
    
    // Обновляем статус игры
    if (Object.keys(game.players).length === 2) {
      game.status = 'playing';
    }
    
    // Отправляем информацию о подключении
    socket.emit('joined', {
      color: playerColor,
      gameId,
      fen: game.chess.fen(),
      pgn: game.chess.pgn(),
      turn: game.turn
    });
    
    // Уведомляем всех в комнате об обновлении
    io.to(gameId).emit('game_update', {
      players: game.players,
      status: game.status,
      turn: game.turn
    });
  });

  // Ход фигуры
  socket.on('move', ({ gameId, from, to, promotion = 'q' }) => {
    const game = games.get(gameId);
    
    if (!game || game.status !== 'playing') {
      socket.emit('error', 'Игра не активна');
      return;
    }
    
    // Проверяем, может ли игрок ходить
    const playerColor = socket.playerColor;
    const currentTurn = game.turn === 'w' ? 'white' : 'black';
    
    if (playerColor !== currentTurn) {
      socket.emit('error', 'Сейчас не ваш ход');
      return;
    }
    
    try {
      const move = game.chess.move({
        from,
        to,
        promotion
      });
      
      if (move) {
        game.moves.push(move);
        game.turn = game.chess.turn(); // 'w' или 'b'
        
        // Отправляем обновление всем в комнате
        io.to(gameId).emit('move_made', {
          from,
          to,
          promotion,
          fen: game.chess.fen(),
          pgn: game.chess.pgn(),
          turn: game.turn,
          player: playerColor,
          move
        });
        
        // Проверяем конец игры
        if (game.chess.isGameOver()) {
          let result = 'draw';
          
          if (game.chess.isCheckmate()) {
            result = playerColor === 'white' ? 'white' : 'black';
          }
          
          game.status = 'finished';
          game.result = result;
          
          io.to(gameId).emit('game_over', {
            result,
            reason: game.chess.isCheckmate() ? 'checkmate' : 
                    game.chess.isDraw() ? 'draw' : 
                    game.chess.isStalemate() ? 'stalemate' : 'unknown'
          });
        }
      }
    } catch (error) {
      socket.emit('error', 'Недопустимый ход');
    }
  });

  // Отправка сообщения в чат
  socket.on('chat_message', ({ gameId, message }) => {
    const game = games.get(gameId);
    if (game && game.players[socket.playerColor]) {
      io.to(gameId).emit('chat_message', {
        player: socket.playerColor,
        username: game.players[socket.playerColor].username,
        message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    if (socket.gameId) {
      const game = games.get(socket.gameId);
      
      if (game && game.players[socket.playerColor]) {
        // Удаляем игрока из игры
        delete game.players[socket.playerColor];
        
        // Уведомляем другого игрока
        io.to(socket.gameId).emit('player_disconnected', {
          player: socket.playerColor
        });
        
        // Если игра активна, завершаем ее
        if (game.status === 'playing') {
          game.status = 'finished';
          game.result = 'abandoned';
          
          io.to(socket.gameId).emit('game_over', {
            result: 'abandoned',
            reason: 'Игрок покинул игру'
          });
        }
      }
    }
  });
});

// Статическая раздача клиентских файлов
app.use(express.static('public'));

// Маршрут для приглашения
app.get('/game/:gameId', (req, res) => {
  res.sendFile(__dirname + '/public/game.html');
});

// Маршрут для главной страницы
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
