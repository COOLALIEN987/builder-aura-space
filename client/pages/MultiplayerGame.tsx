import { useState, useEffect } from 'react';
import { socketService } from '@/services/socket';
import { GameState, gameScenarios, AnswerSubmission } from '@shared/gameData';
import Lobby from '@/components/Lobby';
import WaitingRoom from '@/components/WaitingRoom';
import AdminDashboard from '@/components/AdminDashboard';
import QuestionDisplay from '@/components/QuestionDisplay';
import MultiplayerDice from '@/components/MultiplayerDice';
import { Card } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { Gamepad2, AlertTriangle } from 'lucide-react';

export default function MultiplayerGame() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [availableScenarios, setAvailableScenarios] = useState<number[]>([]);
  const [playerAnswers, setPlayerAnswers] = useState<Array<{
    playerId: string;
    playerName: string;
    answer: any;
  }>>([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Initialize socket connection
  useEffect(() => {
    socketService.connect();

    // Set up event listeners
    socketService.on('gameState', (newGameState: GameState) => {
      setGameState(newGameState);
    });

    socketService.on('playerJoined', (data: { playerId: string; isAdmin: boolean }) => {
      setPlayerId(data.playerId);
      setIsAdmin(data.isAdmin);
      setIsConnecting(false);
      setError(null);
      
      if (data.isAdmin) {
        socketService.getAvailableScenarios();
      }
    });

    socketService.on('availableScenarios', (scenarios: number[]) => {
      setAvailableScenarios(scenarios);
    });

    socketService.on('playerAnswered', (data: any) => {
      setPlayerAnswers(prev => [...prev, data]);
    });

    socketService.on('answerSubmitted', () => {
      setIsSubmitting(false);
      toast({
        title: "Answer Submitted",
        description: "Your answer has been recorded successfully!",
      });
    });

    socketService.on('eliminated', () => {
      toast({
        title: "You've been eliminated",
        description: "You can still watch the game continue.",
        variant: "destructive",
      });
    });

    socketService.on('error', (error: { message: string }) => {
      setError(error.message);
      setIsConnecting(false);
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    });

    return () => {
      socketService.disconnect();
    };
  }, []);

  // Calculate time left for questions
  useEffect(() => {
    if (gameState?.phase === 'question' && gameState.questionStartTime) {
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - gameState.questionStartTime!) / 1000);
        const remaining = Math.max(0, 60 - elapsed);
        setTimeLeft(remaining);
        
        if (remaining === 0) {
          clearInterval(interval);
        }
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [gameState?.phase, gameState?.questionStartTime]);

  // Update available scenarios when game state changes
  useEffect(() => {
    if (isAdmin && gameState) {
      socketService.getAvailableScenarios();
    }
  }, [isAdmin, gameState?.usedScenarios]);

  const handleJoinGame = (name: string, isAdminJoin = false, adminPassword?: string) => {
    setIsConnecting(true);
    setError(null);
    socketService.joinGame(name, isAdminJoin, adminPassword);
  };

  const handleRollDice = (targetNumber: number) => {
    socketService.rollDice(targetNumber);
  };

  const handleSubmitAnswer = (answer: AnswerSubmission) => {
    setIsSubmitting(true);
    socketService.submitAnswer(answer);
  };

  const handleEliminatePlayer = (playerId: string) => {
    socketService.eliminatePlayer(playerId);
  };

  const handleEndQuestion = () => {
    socketService.endQuestion();
  };

  const handleResetGame = () => {
    socketService.resetGame();
    setPlayerAnswers([]);
  };

  // Auto-join as admin if not connected
  useEffect(() => {
    if (!playerId && !isConnecting) {
      setIsConnecting(true);
      handleJoinGame('Game Admin', true, 'admin123');
    }
  }, [playerId, isConnecting]);

  // Show loading while connecting
  if (!playerId || !gameState) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <div className="text-2xl font-bold text-foreground">Loading Monopoly Madness...</div>
          <div className="text-muted-foreground">Setting up your game control panel</div>
        </div>
      </div>
    );
  }

  const currentPlayer = gameState.players[playerId];
  const currentScenario = gameState.currentScenario 
    ? gameScenarios.find(s => s.id === gameState.currentScenario)
    : null;

  // Check if player has submitted answer for current scenario
  const hasSubmitted = currentPlayer && gameState.currentScenario
    ? currentPlayer.answers.some(a => a.scenarioId === gameState.currentScenario)
    : false;

  // Show admin dashboard
  if (isAdmin) {
    return (
      <AdminDashboard
        gameState={gameState}
        playerId={playerId}
        onRollDice={handleRollDice}
        onEliminatePlayer={handleEliminatePlayer}
        onEndQuestion={handleEndQuestion}
        onResetGame={handleResetGame}
        availableScenarios={availableScenarios}
        playerAnswers={playerAnswers}
      />
    );
  }

  // Show elimination screen
  if (currentPlayer?.eliminated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="space-y-4">
            <div className="flex justify-center">
              <div className="p-4 bg-red-500/20 rounded-xl">
                <AlertTriangle className="w-12 h-12 text-red-400" />
              </div>
            </div>
            
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-foreground">You've been eliminated</h1>
              <p className="text-muted-foreground">
                You can still watch the game continue, but you can't participate anymore.
              </p>
            </div>

            <div className="text-sm text-muted-foreground">
              Final Score: {currentPlayer.score} points
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Show question if active
  if (gameState.phase === 'question' && currentScenario) {
    return (
      <QuestionDisplay
        scenario={currentScenario}
        timeLeft={timeLeft}
        onSubmitAnswer={handleSubmitAnswer}
        hasSubmitted={hasSubmitted}
        isSubmitting={isSubmitting}
      />
    );
  }

  // Show dice rolling animation
  if (gameState.phase === 'rolling') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-8">
          <div className="space-y-4">
            <h1 className="text-4xl font-bold text-foreground">
              Dice is rolling...
            </h1>
            <p className="text-muted-foreground text-lg">
              Get ready for your next challenge!
            </p>
          </div>

          <MultiplayerDice
            value={gameState.diceResult || 1}
            isRolling={gameState.isRolling}
            size="xl"
          />

          <div className="text-sm text-muted-foreground">
            Prepare yourself for the upcoming scenario
          </div>
        </div>
      </div>
    );
  }

  // Show results briefly
  if (gameState.phase === 'results' && currentScenario) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-2xl w-full p-8 text-center space-y-6">
          <div className="space-y-4">
            <h1 className="text-3xl font-bold text-foreground">
              Time's Up!
            </h1>
            <p className="text-muted-foreground">
              All answers for "{currentScenario.title}" have been collected.
            </p>
          </div>

          <div className="p-6 bg-muted rounded-xl">
            <div className="text-sm text-muted-foreground mb-2">Your Status:</div>
            <div className="text-lg font-semibold">
              {hasSubmitted ? '✅ Answer Submitted' : '⏰ Time Expired'}
            </div>
          </div>

          <div className="text-sm text-muted-foreground">
            Returning to waiting room...
          </div>
        </Card>
      </div>
    );
  }

  // Default: Show waiting room
  return (
    <WaitingRoom
      gameState={gameState}
      playerId={playerId}
    />
  );
}
