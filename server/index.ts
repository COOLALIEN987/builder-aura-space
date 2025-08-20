import { createServer } from "http";
import { Server } from "socket.io";
import express from "express";
import cors from "cors";
import { handleDemo } from "./routes/demo";
import { GameState, Player, gameScenarios, AnswerSubmission, VENUES, Venue } from "../shared/gameData";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Initialize venues from template for a single game session
const initializeVenuesForSession = (venueId: string): Record<string, Venue> => {
  const venue = VENUES.find(v => v.id === venueId);
  if (!venue) return {};

  return {
    [venueId]: { ...venue, currentPlayers: 0, players: [] }
  };
};

// Create separate game sessions for each venue
const gameStates: Record<string, GameState> = {};

VENUES.forEach(venue => {
  gameStates[venue.id] = {
    id: venue.id,
    phase: 'lobby',
    currentScenario: null,
    diceResult: null,
    isRolling: false,
    questionStartTime: null,
    usedScenarios: [],
    players: {},
    venues: initializeVenuesForSession(venue.id),
    adminId: null,
    settings: {
      adminPassword: 'admin123',
      maxPlayers: 25 // Each venue has 25 players max
    }
  };
});

// Global venue overview (for initial loading)
const globalVenueState = {
  venues: VENUES.reduce((acc, venue) => {
    acc[venue.id] = { ...venue, currentPlayers: 0, players: [] };
    return acc;
  }, {} as Record<string, Venue>)
};

// Timer references for auto-submitting answers (one per venue)
const questionTimers: Record<string, NodeJS.Timeout | null> = {};
VENUES.forEach(venue => {
  questionTimers[venue.id] = null;
});

// Helper functions
const generatePlayerId = () => Math.random().toString(36).substr(2, 9);

const broadcastGameStateToVenue = (venueId: string) => {
  const gameState = gameStates[venueId];
  if (!gameState) return;

  // Emit to all players in this venue
  Object.keys(gameState.players).forEach(playerId => {
    io.to(playerId).emit('gameState', gameState);
  });

  // Update global venue state
  const venue = gameState.venues[venueId];
  if (venue) {
    globalVenueState.venues[venueId] = venue;
  }
};

const broadcastToVenueAdmin = (venueId: string, event: string, data: any) => {
  const gameState = gameStates[venueId];
  if (gameState && gameState.adminId) {
    io.to(gameState.adminId).emit(event, data);
  }
};

const getAvailableScenariosForVenue = (venueId: string) => {
  const gameState = gameStates[venueId];
  if (!gameState) return [];

  return Array.from({ length: 25 }, (_, i) => i + 1).filter(
    id => !gameState.usedScenarios.includes(id)
  );
};

const endQuestionForVenue = (venueId: string) => {
  const gameState = gameStates[venueId];
  if (!gameState) return;

  if (questionTimers[venueId]) {
    clearTimeout(questionTimers[venueId]!);
    questionTimers[venueId] = null;
  }

  // Auto-submit empty answers for players who didn't submit
  Object.values(gameState.players).forEach(player => {
    if (!player.eliminated && gameState.currentScenario) {
      const hasSubmitted = player.answers.some(
        answer => answer.scenarioId === gameState.currentScenario
      );

      if (!hasSubmitted) {
        player.answers.push({
          scenarioId: gameState.currentScenario,
          justification: '[Time expired - no answer]',
          submittedAt: Date.now()
        });
      }
    }
  });

  gameState.phase = 'results';
  broadcastGameStateToVenue(venueId);

  // Show results for 5 seconds, then go back to waiting
  setTimeout(() => {
    gameState.phase = 'waiting';
    broadcastGameStateToVenue(venueId);
  }, 5000);
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Player joins game
  socket.on('joinGame', (data: { name: string; teamName?: string; venueId?: string; isAdmin?: boolean; adminPassword?: string; adminVenueId?: string }) => {
    const { name, teamName, venueId, isAdmin = false, adminPassword, adminVenueId } = data;

    // Validate admin
    if (isAdmin) {
      if (!adminVenueId) {
        socket.emit('error', { message: 'Venue selection is required for admin' });
        return;
      }

      const gameState = gameStates[adminVenueId];
      if (!gameState) {
        socket.emit('error', { message: 'Invalid venue selected' });
        return;
      }

      if (adminPassword !== gameState.settings.adminPassword) {
        socket.emit('error', { message: 'Invalid admin password' });
        return;
      }

      if (gameState.adminId && gameState.adminId !== socket.id) {
        socket.emit('error', { message: 'Admin already exists for this venue' });
        return;
      }

      gameState.adminId = socket.id;
    }

    // Determine which venue's game session to use
    const targetVenueId = isAdmin ? adminVenueId! : venueId!;
    const gameState = gameStates[targetVenueId];

    if (!gameState) {
      socket.emit('error', { message: 'Invalid venue selected' });
      return;
    }

    // Check if venue game is full
    const playerCount = Object.keys(gameState.players).length;
    if (!isAdmin && playerCount >= gameState.settings.maxPlayers) {
      socket.emit('error', { message: 'This venue is full' });
      return;
    }

    // For non-admin players, validate and assign venue
    if (!isAdmin) {
      if (!venueId) {
        socket.emit('error', { message: 'Venue selection is required' });
        return;
      }

      const venue = gameState.venues[venueId];
      if (!venue) {
        socket.emit('error', { message: 'Invalid venue selected' });
        return;
      }

      if (venue.currentPlayers >= venue.maxPlayers) {
        socket.emit('error', { message: 'Selected venue is full' });
        return;
      }

      // Add player to venue
      venue.players.push(socket.id);
      venue.currentPlayers++;

      // Update global venue state
      globalVenueState.venues[venueId] = { ...venue };
    }

    // Create player
    const player: Player = {
      id: socket.id,
      name,
      teamName,
      venueId: isAdmin ? adminVenueId : venueId,
      isAdmin,
      connected: true,
      answers: [],
      score: 0,
      eliminated: false
    };

    gameState.players[socket.id] = player;
    socket.emit('playerJoined', { playerId: socket.id, isAdmin, venueId: targetVenueId });
    broadcastGameStateToVenue(targetVenueId);

    console.log(`${isAdmin ? 'Admin' : 'Player'} joined venue ${targetVenueId}:`, name);
  });

  // Admin rolls dice
  socket.on('rollDice', (targetNumber: number) => {
    // Find which venue this admin manages
    const adminVenueId = Object.keys(gameStates).find(venueId =>
      gameStates[venueId].adminId === socket.id
    );

    if (!adminVenueId) {
      socket.emit('error', { message: 'Admin not found' });
      return;
    }

    const gameState = gameStates[adminVenueId];

    if (gameState.phase !== 'waiting') {
      socket.emit('error', { message: 'Cannot roll dice now' });
      return;
    }

    if (!targetNumber || targetNumber < 1 || targetNumber > 25) {
      socket.emit('error', { message: 'Invalid dice number' });
      return;
    }

    if (gameState.usedScenarios.includes(targetNumber)) {
      socket.emit('error', { message: 'Scenario already used' });
      return;
    }

    gameState.phase = 'rolling';
    gameState.isRolling = true;
    broadcastGameStateToVenue(adminVenueId);

    // Dice animation duration
    setTimeout(() => {
      gameState.diceResult = targetNumber;
      gameState.currentScenario = targetNumber;
      gameState.usedScenarios.push(targetNumber);
      gameState.isRolling = false;
      gameState.phase = 'question';
      gameState.questionStartTime = Date.now();

      broadcastGameStateToVenue(adminVenueId);

      // Start question timer for this venue
      questionTimers[adminVenueId] = setTimeout(() => endQuestionForVenue(adminVenueId), 60000); // 60 seconds
    }, 3000); // 3 second dice animation
  });

  // Player submits answer
  socket.on('submitAnswer', (answer: AnswerSubmission) => {
    // Find which venue this player belongs to
    const playerVenueId = Object.keys(gameStates).find(venueId =>
      gameStates[venueId].players[socket.id]
    );

    if (!playerVenueId) {
      socket.emit('error', { message: 'Player not found in any venue' });
      return;
    }

    const gameState = gameStates[playerVenueId];
    const player = gameState.players[socket.id];

    if (!player || player.eliminated) {
      socket.emit('error', { message: 'Player not found or eliminated' });
      return;
    }

    if (gameState.phase !== 'question' || !gameState.currentScenario) {
      socket.emit('error', { message: 'No active question' });
      return;
    }

    if (answer.scenarioId !== gameState.currentScenario) {
      socket.emit('error', { message: 'Invalid scenario ID' });
      return;
    }

    // Check if player already submitted
    const hasSubmitted = player.answers.some(
      a => a.scenarioId === answer.scenarioId
    );
    if (hasSubmitted) {
      socket.emit('error', { message: 'Answer already submitted' });
      return;
    }

    // Validate justification length
    if (!answer.justification || answer.justification.length > 60) {
      socket.emit('error', { message: 'Justification must be 1-60 characters' });
      return;
    }

    // Add answer
    player.answers.push({
      scenarioId: answer.scenarioId,
      selectedOption: answer.selectedOption,
      justification: answer.justification,
      submittedAt: Date.now()
    });

    // Update score (simple scoring for now)
    player.score += 10;

    socket.emit('answerSubmitted');
    broadcastToVenueAdmin(playerVenueId, 'playerAnswered', {
      playerId: socket.id,
      playerName: player.name,
      answer: answer
    });

    console.log(`Player ${player.name} in venue ${playerVenueId} submitted answer for scenario ${answer.scenarioId}`);
  });

  // Admin eliminates player
  socket.on('eliminatePlayer', (playerId: string) => {
    if (socket.id !== gameState.adminId) {
      socket.emit('error', { message: 'Only admin can eliminate players' });
      return;
    }

    const player = gameState.players[playerId];
    if (player && !player.isAdmin) {
      player.eliminated = true;
      io.to(playerId).emit('eliminated');
      broadcastGameState();
      console.log(`Player ${player.name} eliminated`);
    }
  });

  // Admin ends current question
  socket.on('endQuestion', () => {
    if (socket.id !== gameState.adminId) {
      socket.emit('error', { message: 'Only admin can end questions' });
      return;
    }

    if (gameState.phase === 'question') {
      endQuestion();
    }
  });

  // Admin resets game
  socket.on('resetGame', () => {
    if (socket.id !== gameState.adminId) {
      socket.emit('error', { message: 'Only admin can reset game' });
      return;
    }

    // Keep admin and clear everything else
    const adminPlayer = gameState.players[gameState.adminId];
    gameState = {
      ...gameState,
      phase: 'lobby',
      currentScenario: null,
      diceResult: null,
      isRolling: false,
      questionStartTime: null,
      usedScenarios: [],
      players: adminPlayer ? { [gameState.adminId]: adminPlayer } : {},
      venues: initializeVenues()
    };

    if (questionTimer) {
      clearTimeout(questionTimer);
      questionTimer = null;
    }

    broadcastGameState();
    console.log('Game reset by admin');
  });

  // Get available scenarios
  socket.on('getAvailableScenarios', () => {
    if (socket.id === gameState.adminId) {
      socket.emit('availableScenarios', getAvailableScenarios());
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      player.connected = false;

      // If admin disconnects, clear admin
      if (player.isAdmin) {
        gameState.adminId = null;
      } else if (player.venueId) {
        // Remove player from venue
        const venue = gameState.venues[player.venueId];
        if (venue) {
          const playerIndex = venue.players.indexOf(socket.id);
          if (playerIndex > -1) {
            venue.players.splice(playerIndex, 1);
            venue.currentPlayers--;
          }
        }
      }

      // Remove disconnected player from game state after a delay
      setTimeout(() => {
        delete gameState.players[socket.id];
        broadcastGameState();
      }, 30000); // 30 second grace period for reconnection

      broadcastGameState();
      console.log(`Player ${player.name} disconnected`);
    }
  });
});

// API Routes
app.get("/api/ping", (req, res) => {
  res.json({ message: "pong" });
});

app.get("/api/demo", handleDemo);

app.get("/api/game-scenarios", (req, res) => {
  res.json(gameScenarios);
});

app.get("/api/game-state", (req, res) => {
  res.json(gameState);
});

// Export createServer for Vite development
export function createServer() {
  return app;
}

// Start server
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`🎲 Monopoly Madness server running on port ${PORT}`);
  console.log(`🎯 Admin password: ${gameState.settings.adminPassword}`);
});

export { app, httpServer };
