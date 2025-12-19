const WebSocket = require('ws');

// Available colors for players (excluding red 0xff5c5c which is reserved for AI)
const PLAYER_COLORS = [
  0x3ec1ff,  // Blue (original player color)
  0x00ff00,  // Green
  0xffff00,  // Yellow
  0xff00ff,  // Magenta
  0x00ffff,  // Cyan
  0xffa500,  // Orange
  0x8000ff,  // Purple
  0xff1493,  // Deep Pink
  0x00ff7f,  // Spring Green
  0xff6347,  // Tomato
];

// Game constants (should match client)
const GAME_DURATION = 60;
const BASE_SPEED = 60 * 3;
const FLAG_SPEED_MULTIPLIER = 0.8;
const TURN_SPEED = Math.PI * 1.5;
const ENEMY_TURN_SPEED = TURN_SPEED * 0.5;
const COLLISION_RADIUS = 12;
const WORLD_SIZE = 800 * 3;

// Player management
let players = new Map(); // playerId -> { ws, color, car }
let usedColors = new Set();

// Game state
let gameState = {
  players: [],
  aiCar: { x: 0, z: 0, angle: 0, hasFlag: false },
  flagHolderId: null,
  time: 0,
  playerHoldTime: 0,
  enemiesHoldTime: 0,
  finished: false
};

// AI car state
let aiCar = {
  x: Math.cos(Math.PI) * 200,
  z: Math.sin(Math.PI) * 200,
  angle: Math.PI + Math.PI,
  hasFlag: false,
  aiBias: 0,
  immunityTimer: 0
};

// Player input storage
let playerInputs = new Map(); // playerId -> { left, right, lastUpdate }

// Initialize WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

console.log('WebSocket server started on port 8080');

wss.on('connection', (ws) => {
  const playerId = generatePlayerId();
  const color = assignColor();
  
  players.set(playerId, { ws, color, car: null });
  usedColors.add(color);
  
  console.log(`Player ${playerId} connected with color ${color.toString(16)}`);
  
  // Initialize player car
  const playerCar = {
    x: 0,
    z: 0,
    angle: 0,
    hasFlag: false,
    immunityTimer: 0
  };
  players.get(playerId).car = playerCar;
  playerInputs.set(playerId, { left: false, right: false, lastUpdate: Date.now() });
  
  // Send join confirmation
  ws.send(JSON.stringify({
    type: 'joined',
    playerId,
    color
  }));
  
  // Notify other players
  broadcast({ type: 'playerJoined', playerId, color, position: { x: 0, z: 0, angle: 0 } }, playerId);
  
  // Initialize game if this is the first player
  if (players.size === 1) {
    initializeGame();
  }
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleClientMessage(playerId, message);
    } catch (e) {
      console.error('Error parsing client message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    usedColors.delete(color);
    players.delete(playerId);
    playerInputs.delete(playerId);
    broadcast({ type: 'playerLeft', playerId });
    
    // Reset game if no players left
    if (players.size === 0) {
      initializeGame();
    }
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for player ${playerId}:`, error);
  });
});

function assignColor() {
  for (const color of PLAYER_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  // If all colors used, reuse colors
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function generatePlayerId() {
  return Math.random().toString(36).substr(2, 9);
}

function handleClientMessage(playerId, message) {
  switch (message.type) {
    case 'input':
      // Store input for this player
      const input = playerInputs.get(playerId);
      if (input) {
        input.left = message.left || false;
        input.right = message.right || false;
        input.lastUpdate = message.timestamp || Date.now();
      }
      break;
      
    default:
      console.log('Unknown message type:', message.type);
  }
}

function initializeGame() {
  // Reset game state
  gameState.time = 0;
  gameState.finished = false;
  gameState.playerHoldTime = 0;
  gameState.enemiesHoldTime = 0;
  gameState.flagHolderId = null;
  
  // Reset AI car
  aiCar.x = Math.cos(Math.PI) * 200;
  aiCar.z = Math.sin(Math.PI) * 200;
  aiCar.angle = Math.PI + Math.PI;
  aiCar.hasFlag = false;
  aiCar.immunityTimer = 0;
  
  // Reset all player cars
  players.forEach((player, playerId) => {
    if (player.car) {
      player.car.x = 0;
      player.car.z = 0;
      player.car.angle = 0;
      player.car.hasFlag = false;
      player.car.immunityTimer = 0;
    }
  });
  
  // Give flag to random car
  const allCars = [];
  allCars.push({ id: 'ai', car: aiCar });
  players.forEach((player, playerId) => {
    if (player.car) {
      allCars.push({ id: playerId, car: player.car });
    }
  });
  
  if (allCars.length > 0) {
    const randomCar = allCars[Math.floor(Math.random() * allCars.length)];
    randomCar.car.hasFlag = true;
    gameState.flagHolderId = randomCar.id;
  }
}

function updateAI(dt) {
  if (!gameState.flagHolderId) return;
  
  const myPos = { x: aiCar.x, z: aiCar.z };
  const center = { x: 0, z: 0 };
  const ROAM_RADIUS = 200;
  const RETURN_RADIUS = 400;
  
  if (aiCar.hasFlag) {
    // If AI has the flag, roam around the center
    const distToCenter = Math.sqrt(
      Math.pow(center.x - myPos.x, 2) + Math.pow(center.z - myPos.z, 2)
    );
    let targetAngle;
    
    if (distToCenter > RETURN_RADIUS) {
      // If too far from center, head back towards it
      const dirToCenter = {
        x: center.x - myPos.x,
        z: center.z - myPos.z
      };
      const len = Math.sqrt(dirToCenter.x * dirToCenter.x + dirToCenter.z * dirToCenter.z);
      if (len > 0) {
        dirToCenter.x /= len;
        dirToCenter.z /= len;
        targetAngle = Math.atan2(dirToCenter.z, dirToCenter.x);
      } else {
        targetAngle = aiCar.angle;
      }
    } else {
      // Roam in a circular pattern around the center
      const roamAngle = gameState.time * 0.5 + aiCar.aiBias;
      const targetX = Math.cos(roamAngle) * ROAM_RADIUS;
      const targetZ = Math.sin(roamAngle) * ROAM_RADIUS;
      
      const dirToRoamTarget = {
        x: targetX - myPos.x,
        z: targetZ - myPos.z
      };
      const len = Math.sqrt(dirToRoamTarget.x * dirToRoamTarget.x + dirToRoamTarget.z * dirToRoamTarget.z);
      if (len > 0) {
        dirToRoamTarget.x /= len;
        dirToRoamTarget.z /= len;
        targetAngle = Math.atan2(dirToRoamTarget.z, dirToRoamTarget.x);
      } else {
        targetAngle = aiCar.angle;
      }
    }
    
    // Lerp angle
    let diff = ((targetAngle - aiCar.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    diff = Math.max(-ENEMY_TURN_SPEED * dt, Math.min(ENEMY_TURN_SPEED * dt, diff));
    aiCar.angle = aiCar.angle + diff;
    
  } else {
    // Chase flag holder
    let flagHolderCar = null;
    if (gameState.flagHolderId === 'ai') {
      flagHolderCar = aiCar;
    } else {
      const flagHolderPlayer = players.get(gameState.flagHolderId);
      if (flagHolderPlayer && flagHolderPlayer.car) {
        flagHolderCar = flagHolderPlayer.car;
      }
    }
    
    if (flagHolderCar) {
      const dir = {
        x: flagHolderCar.x - myPos.x,
        z: flagHolderCar.z - myPos.z
      };
      const distToFlag = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      if (distToFlag > 0) {
        dir.x /= distToFlag;
        dir.z /= distToFlag;
        const biasScale = Math.min(1.0, distToFlag / 300);
        const targetAngle = Math.atan2(dir.z, dir.x) + aiCar.aiBias * biasScale * 0.4;
        
        // Lerp angle
        let diff = ((targetAngle - aiCar.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        diff = Math.max(-ENEMY_TURN_SPEED * dt, Math.min(ENEMY_TURN_SPEED * dt, diff));
        aiCar.angle = aiCar.angle + diff;
      }
    }
  }
  
  // Move AI car
  const speed = BASE_SPEED * (aiCar.hasFlag ? FLAG_SPEED_MULTIPLIER : 1);
  aiCar.x += Math.cos(aiCar.angle) * speed * dt;
  aiCar.z += Math.sin(aiCar.angle) * speed * dt;
  
  // Keep within world bounds
  const halfWorld = WORLD_SIZE / 2;
  aiCar.x = Math.max(-halfWorld, Math.min(halfWorld, aiCar.x));
  aiCar.z = Math.max(-halfWorld, Math.min(halfWorld, aiCar.z));
  
  // Update immunity timer
  if (aiCar.immunityTimer > 0) {
    aiCar.immunityTimer -= dt;
    if (aiCar.immunityTimer < 0) aiCar.immunityTimer = 0;
  }
}

function updatePlayer(playerId, dt) {
  const player = players.get(playerId);
  if (!player || !player.car) return;
  
  const car = player.car;
  const input = playerInputs.get(playerId);
  
  if (input) {
    if (input.left) car.angle -= TURN_SPEED * dt;
    if (input.right) car.angle += TURN_SPEED * dt;
  }
  
  // Move player car
  const speed = BASE_SPEED * 1.2 * (car.hasFlag ? FLAG_SPEED_MULTIPLIER : 1); // Player is 20% faster
  car.x += Math.cos(car.angle) * speed * dt;
  car.z += Math.sin(car.angle) * speed * dt;
  
  // Keep within world bounds
  const halfWorld = WORLD_SIZE / 2;
  car.x = Math.max(-halfWorld, Math.min(halfWorld, car.x));
  car.z = Math.max(-halfWorld, Math.min(halfWorld, car.z));
  
  // Update immunity timer
  if (car.immunityTimer > 0) {
    car.immunityTimer -= dt;
    if (car.immunityTimer < 0) car.immunityTimer = 0;
  }
}

function updateCollisions() {
  const allCars = [];
  allCars.push({ id: 'ai', car: aiCar });
  players.forEach((player, playerId) => {
    if (player.car) {
      allCars.push({ id: playerId, car: player.car });
    }
  });
  
  for (let i = 0; i < allCars.length; i++) {
    for (let j = i + 1; j < allCars.length; j++) {
      const a = allCars[i];
      const b = allCars[j];
      
      const dx = a.car.x - b.car.x;
      const dz = a.car.z - b.car.z;
      const d2 = dx * dx + dz * dz;
      
      if (d2 < COLLISION_RADIUS * COLLISION_RADIUS) {
        const aHasImmunity = a.car.immunityTimer > 0;
        const bHasImmunity = b.car.immunityTimer > 0;
        
        if (a.car.hasFlag && !b.car.hasFlag) {
          if (!aHasImmunity) {
            a.car.hasFlag = false;
            b.car.hasFlag = true;
            gameState.flagHolderId = b.id;
            b.car.immunityTimer = 0.5;
            
            // Broadcast flag transfer
            broadcast({
              type: 'flagTransfer',
              fromPlayerId: a.id,
              toPlayerId: b.id
            });
          }
        } else if (!a.car.hasFlag && b.car.hasFlag) {
          if (!bHasImmunity) {
            b.car.hasFlag = false;
            a.car.hasFlag = true;
            gameState.flagHolderId = a.id;
            a.car.immunityTimer = 0.5;
            
            // Broadcast flag transfer
            broadcast({
              type: 'flagTransfer',
              fromPlayerId: b.id,
              toPlayerId: a.id
            });
          }
        }
      }
    }
  }
}

function updateGameState() {
  const dt = 1 / 60; // 60 FPS
  
  // Update time
  gameState.time += dt;
  if (gameState.time >= GAME_DURATION) {
    gameState.time = GAME_DURATION;
    gameState.finished = true;
  }
  
  // Update AI
  updateAI(dt);
  
  // Update players
  players.forEach((player, playerId) => {
    updatePlayer(playerId, dt);
  });
  
  // Update collisions
  updateCollisions();
  
  // Update hold times
  if (gameState.flagHolderId) {
    if (gameState.flagHolderId === 'ai') {
      gameState.enemiesHoldTime += dt;
    } else {
      gameState.playerHoldTime += dt;
    }
  }
  
  // Build state for clients
  const state = {
    players: [],
    aiCar: {
      x: aiCar.x,
      z: aiCar.z,
      angle: aiCar.angle,
      hasFlag: aiCar.hasFlag
    },
    flagHolderId: gameState.flagHolderId,
    time: gameState.time,
    playerHoldTime: gameState.playerHoldTime,
    enemiesHoldTime: gameState.enemiesHoldTime,
    finished: gameState.finished
  };
  
  players.forEach((player, playerId) => {
    if (player.car) {
      state.players.push({
        playerId: playerId,
        x: player.car.x,
        z: player.car.z,
        angle: player.car.angle,
        hasFlag: player.car.hasFlag
      });
    }
  });
  
  return state;
}

function broadcast(message, excludePlayerId = null) {
  players.forEach((player, id) => {
    if (id !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
      try {
        player.ws.send(JSON.stringify(message));
      } catch (e) {
        console.error(`Error sending message to player ${id}:`, e);
      }
    }
  });
}

// Game loop (60 FPS)
setInterval(() => {
  if (players.size > 0) {
    const state = updateGameState();
    broadcast({ type: 'gameState', state });
  }
}, 1000 / 60);

