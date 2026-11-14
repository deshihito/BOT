import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WEB_GAMES, getWebGame } from "@/lib/games-catalog";
import { GameDetailHeader } from "../GamesChrome";
import ChessClient from "../chess/ChessClient";
import BalkuClient from "../balku/BalkuClient";
import LllClient from "../lll/LllClient";
import MinesweeperClient from "../minesweeper/MinesweeperClient";
import SliderClient from "../2048/SliderClient";
import MemoryClient from "../memory/MemoryClient";
import ReversiClient from "../reversi/ReversiClient";
import Connect4Client from "../connect4/Connect4Client";
import GomokuClient from "../gomoku/GomokuClient";
import BattleshipClient from "../battleship/BattleshipClient";
import DaifugoClient from "../daifugo/DaifugoClient";
import WerewolfClient from "../werewolf/WerewolfClient";
import SudokuClient from "../sudoku/SudokuClient";
import FifteenClient from "../fifteen/FifteenClient";
import LightsOutClient from "../lightsout/LightsOutClient";
import SnakeClient from "../snake/SnakeClient";
import BreakoutClient from "../breakout/BreakoutClient";
import PongClient from "../pong/PongClient";
import MoleClient from "../mole/MoleClient";
import SolitaireClient from "../solitaire/SolitaireClient";
import WordleClient from "../wordle/WordleClient";
import TypingClient from "../typing/TypingClient";
import BlackjackClient from "../blackjack/BlackjackClient";
import StackerClient from "../stacker/StackerClient";
import ColormatchClient from "../colormatch/ColormatchClient";
import NumberMemoryClient from "../numbermemory/NumberMemoryClient";
import MazeClient from "../maze/MazeClient";
import MastermindClient from "../mastermind/MastermindClient";
import HangmanClient from "../hangman/HangmanClient";
import ReactionClient from "../reaction/ReactionClient";
import AimClient from "../aim/AimClient";
import DodgeClient from "../dodge/DodgeClient";
import FallingClient from "../falling/FallingClient";
import SimonClient from "../simon/SimonClient";
import TictactoeClient from "../tictactoe/TictactoeClient";
import CheckersClient from "../checkers/CheckersClient";
import BabanukiClient from "../babanuki/BabanukiClient";
import TerritoryClient from "../territory/TerritoryClient";
import NonogramClient from "../nonogram/NonogramClient";
import PegClient from "../peg/PegClient";
import HanoiClient from "../hanoi/HanoiClient";
import SpeedClient from "../speed/SpeedClient";
import SlotClient from "../slot/SlotClient";
import BingoClient from "../bingo/BingoClient";
import AmidaClient from "../amida/AmidaClient";
import KanacrossClient from "../kanacross/KanacrossClient";
import QuizClient from "../quiz/QuizClient";
import NumberCodeClient from "../numbercode/NumberCodeClient";
import StopwatchClient from "../stopwatch/StopwatchClient";
import QuizBattleClient from "../quizbattle/QuizBattleClient";
import DartsClient from "../darts/DartsClient";
import TouchNumberClient from "../touchnumber/TouchNumberClient";
import RouletteClient from "../roulette/RouletteClient";
import WordwolfClient from "../wordwolf/WordwolfClient";
import SpotDiffClient from "../spotdiff/SpotDiffClient";
import FlagQuizClient from "../flagquiz/FlagQuizClient";
import HighLowClient from "../highlow/HighLowClient";
import DrawGuessClient from "../drawguess/DrawGuessClient";
import SokobanClient from "../sokoban/SokobanClient";
import SugorokuClient from "../sugoroku/SugorokuClient";
import AnagramClient from "../anagram/AnagramClient";
import JankenClient from "../janken/JankenClient";
import PipeClient from "../pipe/PipeClient";
import DrawPokerClient from "../drawpoker/DrawPokerClient";
import BombPassClient from "../bombpass/BombPassClient";
import ShiritoriClient from "../shiritori/ShiritoriClient";
import NurikabeClient from "../nurikabe/NurikabeClient";
import FreeCellClient from "../freecell/FreeCellClient";
import ColumnsClient from "../columns/ColumnsClient";
import MajorityClient from "../majority/MajorityClient";
import HashiClient from "../hashi/HashiClient";
import DiceQuestClient from "../dicequest/DiceQuestClient";
import PentominoClient from "../pentomino/PentominoClient";
import TexasClient from "../texas/TexasClient";
import NumberLinkClient from "../numberlink/NumberLinkClient";
import PyramidClient from "../pyramid/PyramidClient";
import YahtzeeClient from "../yahtzee/YahtzeeClient";
import NanjaClient from "../nanja/NanjaClient";
import WordSearchClient from "../wordsearch/WordSearchClient";
import BaccaratClient from "../baccarat/BaccaratClient";
import LiarsDiceClient from "../liarsdice/LiarsDiceClient";
import MinorityClient from "../minority/MinorityClient";
import MushokuClient from "../mushoku/MushokuClient";
import FloodItClient from "../floodit/FloodItClient";
import LaserClient from "../laser/LaserClient";
import CountdownClient from "../countdown/CountdownClient";
import SpiderClient from "../spider/SpiderClient";
import GolfClient from "../golf/GolfClient";
import BackgammonClient from "../backgammon/BackgammonClient";
import DominoClient from "../domino/DominoClient";
import HalmaClient from "../halma/HalmaClient";
import RushHourClient from "../rushhour/RushHourClient";
import MonteCarloClient from "../montecarlo/MonteCarloClient";
import CheatClient from "../cheat/CheatClient";
import SameGameClient from "../samegame/SameGameClient";
import TentsClient from "../tents/TentsClient";
import HagetakaClient from "../hagetaka/HagetakaClient";
import BurstClient from "../burst/BurstClient";
import BlockPuzzleClient from "../blockpuzzle/BlockPuzzleClient";
import WaterSortClient from "../watersort/WaterSortClient";
import MahjongClient from "../mahjong/MahjongClient";
import ShikakuClient from "../shikaku/ShikakuClient";
import KenkenClient from "../kenken/KenkenClient";
import BinairoClient from "../binairo/BinairoClient";
import FlashAnzanClient from "../flashanzan/FlashAnzanClient";
import KakuroClient from "../kakuro/KakuroClient";
import CubeClient from "../cube/CubeClient";
import DartsBattleClient from "../dartsbattle/DartsBattleClient";
import SkyscrapersClient from "../skyscrapers/SkyscrapersClient";
import SlantClient from "../slant/SlantClient";
import StopBattleClient from "../stopbattle/StopBattleClient";
import AkariClient from "../akari/AkariClient";
import DiceRollClient from "../diceroll/DiceRollClient";
import BingoBattleClient from "../bingobattle/BingoBattleClient";
import AlphameticClient from "../alphametic/AlphameticClient";
import RiverClient from "../river/RiverClient";
import SimonBattleClient from "../simonbattle/SimonBattleClient";
import KnightsTourClient from "../knightstour/KnightsTourClient";
import QueensClient from "../queens/QueensClient";
import CalcRaceClient from "../calcrace/CalcRaceClient";
import CraneGameClient from "../cranegame/CraneGameClient";
import MusicalChairsClient from "../musicalchairs/MusicalChairsClient";
import MergeFruitClient from "../mergefruit/MergeFruitClient";
import WordBasketClient from "../wordbasket/WordBasketClient";
import IceMazeClient from "../icemaze/IceMazeClient";
import TypeRaceClient from "../typerace/TypeRaceClient";
import HeartsClient from "../hearts/HeartsClient";
import PuttGolfClient from "../puttgolf/PuttGolfClient";
import TsumeClient from "../tsume/TsumeClient";
import BowlingClient from "../bowling/BowlingClient";
import AirHockeyClient from "../airhockey/AirHockeyClient";
import PenaltyClient from "../penalty/PenaltyClient";
import MissileClient from "../missile/MissileClient";
import DragRaceClient from "../dragrace/DragRaceClient";
import BilliardsClient from "../billiards/BilliardsClient";
import CurlingClient from "../curling/CurlingClient";
import ChessPuzzleClient from "../chesspuzzle/ChessPuzzleClient";
import BalanceStackClient from "../balancestack/BalanceStackClient";
import ChinchiroClient from "../chinchiro/ChinchiroClient";
import CrocodileClient from "../crocodile/CrocodileClient";
import KwordleClient from "../kwordle/KwordleClient";
import WorldBoxClient from "../worldbox/WorldBoxClient";

export function generateStaticParams() {
  return WEB_GAMES.map((game) => ({ id: game.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const game = getWebGame((await params).id);
  if (!game) return {};
  return {
    title: game.title,
    description: game.description,
    alternates: { canonical: `/games/${game.slug}` },
  };
}

export default async function WebGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const game = getWebGame(id);
  if (!game) notFound();
  if (game.slug === "chess" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ChessClient />
      </>
    );
  }
  if (game.slug === "balku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BalkuClient />
      </>
    );
  }
  if (game.slug === "lll" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <LllClient />
      </>
    );
  }
  if (game.slug === "minesweeper" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MinesweeperClient />
      </>
    );
  }
  if (game.slug === "2048" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SliderClient />
      </>
    );
  }
  if (game.slug === "memory" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MemoryClient />
      </>
    );
  }
  if (game.slug === "reversi" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ReversiClient />
      </>
    );
  }
  if (game.slug === "connect4" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <Connect4Client />
      </>
    );
  }
  if (game.slug === "gomoku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <GomokuClient />
      </>
    );
  }
  if (game.slug === "battleship" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BattleshipClient />
      </>
    );
  }
  if (game.slug === "daifugo" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DaifugoClient />
      </>
    );
  }
  if (game.slug === "werewolf" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WerewolfClient />
      </>
    );
  }
  if (game.slug === "sudoku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SudokuClient />
      </>
    );
  }
  if (game.slug === "fifteen" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FifteenClient />
      </>
    );
  }
  if (game.slug === "lightsout" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <LightsOutClient />
      </>
    );
  }
  if (game.slug === "snake" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SnakeClient />
      </>
    );
  }
  if (game.slug === "breakout" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BreakoutClient />
      </>
    );
  }
  if (game.slug === "pong" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PongClient />
      </>
    );
  }
  if (game.slug === "mole" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MoleClient />
      </>
    );
  }
  if (game.slug === "solitaire" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SolitaireClient />
      </>
    );
  }
  if (game.slug === "wordle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WordleClient />
      </>
    );
  }
  if (game.slug === "typing" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TypingClient />
      </>
    );
  }
  if (game.slug === "blackjack" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BlackjackClient />
      </>
    );
  }
  if (game.slug === "stacker" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <StackerClient />
      </>
    );
  }
  if (game.slug === "colormatch" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ColormatchClient />
      </>
    );
  }
  if (game.slug === "numbermemory" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NumberMemoryClient />
      </>
    );
  }
  if (game.slug === "maze" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MazeClient />
      </>
    );
  }
  if (game.slug === "mastermind" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MastermindClient />
      </>
    );
  }
  if (game.slug === "hangman" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HangmanClient />
      </>
    );
  }
  if (game.slug === "reaction" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ReactionClient />
      </>
    );
  }
  if (game.slug === "aim" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AimClient />
      </>
    );
  }
  if (game.slug === "dodge" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DodgeClient />
      </>
    );
  }
  if (game.slug === "falling" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FallingClient />
      </>
    );
  }
  if (game.slug === "simon" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SimonClient />
      </>
    );
  }
  if (game.slug === "tictactoe" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TictactoeClient />
      </>
    );
  }
  if (game.slug === "checkers" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CheckersClient />
      </>
    );
  }
  if (game.slug === "babanuki" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BabanukiClient />
      </>
    );
  }
  if (game.slug === "territory" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TerritoryClient />
      </>
    );
  }
  if (game.slug === "nonogram" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NonogramClient />
      </>
    );
  }
  if (game.slug === "peg" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PegClient />
      </>
    );
  }
  if (game.slug === "hanoi" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HanoiClient />
      </>
    );
  }
  if (game.slug === "speed" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SpeedClient />
      </>
    );
  }
  if (game.slug === "slot" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SlotClient />
      </>
    );
  }
  if (game.slug === "bingo" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BingoClient />
      </>
    );
  }
  if (game.slug === "amida" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AmidaClient />
      </>
    );
  }
  if (game.slug === "kanacross" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <KanacrossClient />
      </>
    );
  }
  if (game.slug === "quiz" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <QuizClient />
      </>
    );
  }
  if (game.slug === "numbercode" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NumberCodeClient />
      </>
    );
  }
  if (game.slug === "stopwatch" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <StopwatchClient />
      </>
    );
  }
  if (game.slug === "quizbattle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <QuizBattleClient />
      </>
    );
  }
  if (game.slug === "darts" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DartsClient />
      </>
    );
  }
  if (game.slug === "touchnumber" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TouchNumberClient />
      </>
    );
  }
  if (game.slug === "roulette" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <RouletteClient />
      </>
    );
  }
  if (game.slug === "wordwolf" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WordwolfClient />
      </>
    );
  }
  if (game.slug === "spotdiff" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SpotDiffClient />
      </>
    );
  }
  if (game.slug === "flagquiz" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FlagQuizClient />
      </>
    );
  }
  if (game.slug === "highlow" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HighLowClient />
      </>
    );
  }
  if (game.slug === "drawguess" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DrawGuessClient />
      </>
    );
  }
  if (game.slug === "sokoban" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SokobanClient />
      </>
    );
  }
  if (game.slug === "sugoroku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SugorokuClient />
      </>
    );
  }
  if (game.slug === "anagram" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AnagramClient />
      </>
    );
  }
  if (game.slug === "janken" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <JankenClient />
      </>
    );
  }
  if (game.slug === "pipe" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PipeClient />
      </>
    );
  }
  if (game.slug === "drawpoker" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DrawPokerClient />
      </>
    );
  }
  if (game.slug === "bombpass" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BombPassClient />
      </>
    );
  }
  if (game.slug === "shiritori" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ShiritoriClient />
      </>
    );
  }
  if (game.slug === "nurikabe" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NurikabeClient />
      </>
    );
  }
  if (game.slug === "freecell" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FreeCellClient />
      </>
    );
  }
  if (game.slug === "columns" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ColumnsClient />
      </>
    );
  }
  if (game.slug === "majority" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MajorityClient />
      </>
    );
  }
  if (game.slug === "hashi" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HashiClient />
      </>
    );
  }
  if (game.slug === "dicequest" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DiceQuestClient />
      </>
    );
  }
  if (game.slug === "pentomino" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PentominoClient />
      </>
    );
  }
  if (game.slug === "texas" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TexasClient />
      </>
    );
  }
  if (game.slug === "numberlink" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NumberLinkClient />
      </>
    );
  }
  if (game.slug === "pyramid" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PyramidClient />
      </>
    );
  }
  if (game.slug === "yahtzee" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <YahtzeeClient />
      </>
    );
  }
  if (game.slug === "nanja" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <NanjaClient />
      </>
    );
  }
  if (game.slug === "wordsearch" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WordSearchClient />
      </>
    );
  }
  if (game.slug === "baccarat" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BaccaratClient />
      </>
    );
  }
  if (game.slug === "liarsdice" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <LiarsDiceClient />
      </>
    );
  }
  if (game.slug === "minority" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MinorityClient />
      </>
    );
  }
  if (game.slug === "mushoku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MushokuClient />
      </>
    );
  }
  if (game.slug === "floodit" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FloodItClient />
      </>
    );
  }
  if (game.slug === "laser" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <LaserClient />
      </>
    );
  }
  if (game.slug === "countdown" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CountdownClient />
      </>
    );
  }
  if (game.slug === "spider" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SpiderClient />
      </>
    );
  }
  if (game.slug === "golf" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <GolfClient />
      </>
    );
  }
  if (game.slug === "backgammon" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BackgammonClient />
      </>
    );
  }
  if (game.slug === "domino" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DominoClient />
      </>
    );
  }
  if (game.slug === "halma" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HalmaClient />
      </>
    );
  }
  if (game.slug === "rushhour" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <RushHourClient />
      </>
    );
  }
  if (game.slug === "montecarlo" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MonteCarloClient />
      </>
    );
  }
  if (game.slug === "cheat" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CheatClient />
      </>
    );
  }
  if (game.slug === "samegame" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SameGameClient />
      </>
    );
  }
  if (game.slug === "tents" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TentsClient />
      </>
    );
  }
  if (game.slug === "hagetaka" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HagetakaClient />
      </>
    );
  }
  if (game.slug === "burst" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BurstClient />
      </>
    );
  }
  if (game.slug === "blockpuzzle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BlockPuzzleClient />
      </>
    );
  }
  if (game.slug === "watersort" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WaterSortClient />
      </>
    );
  }
  if (game.slug === "mahjong" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MahjongClient />
      </>
    );
  }
  if (game.slug === "shikaku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ShikakuClient />
      </>
    );
  }
  if (game.slug === "kenken" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <KenkenClient />
      </>
    );
  }
  if (game.slug === "binairo" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BinairoClient />
      </>
    );
  }
  if (game.slug === "flashanzan" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <FlashAnzanClient />
      </>
    );
  }
  if (game.slug === "kakuro" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <KakuroClient />
      </>
    );
  }
  if (game.slug === "cube" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CubeClient />
      </>
    );
  }
  if (game.slug === "dartsbattle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DartsBattleClient />
      </>
    );
  }
  if (game.slug === "skyscrapers" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SkyscrapersClient />
      </>
    );
  }
  if (game.slug === "slant" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SlantClient />
      </>
    );
  }
  if (game.slug === "stopbattle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <StopBattleClient />
      </>
    );
  }
  if (game.slug === "akari" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AkariClient />
      </>
    );
  }
  if (game.slug === "diceroll" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DiceRollClient />
      </>
    );
  }
  if (game.slug === "bingobattle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BingoBattleClient />
      </>
    );
  }
  if (game.slug === "alphametic" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AlphameticClient />
      </>
    );
  }
  if (game.slug === "river" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <RiverClient />
      </>
    );
  }
  if (game.slug === "simonbattle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SimonBattleClient />
      </>
    );
  }
  if (game.slug === "knightstour" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <KnightsTourClient />
      </>
    );
  }
  if (game.slug === "queens" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <QueensClient />
      </>
    );
  }
  if (game.slug === "calcrace" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CalcRaceClient />
      </>
    );
  }
  if (game.slug === "cranegame" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CraneGameClient />
      </>
    );
  }
  if (game.slug === "musicalchairs" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MusicalChairsClient />
      </>
    );
  }
  if (game.slug === "mergefruit" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MergeFruitClient />
      </>
    );
  }
  if (game.slug === "wordbasket" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WordBasketClient />
      </>
    );
  }
  if (game.slug === "icemaze" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <IceMazeClient />
      </>
    );
  }
  if (game.slug === "typerace" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TypeRaceClient />
      </>
    );
  }
  if (game.slug === "hearts" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <HeartsClient />
      </>
    );
  }
  if (game.slug === "puttgolf" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PuttGolfClient />
      </>
    );
  }
  if (game.slug === "tsume" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <TsumeClient />
      </>
    );
  }
  if (game.slug === "bowling" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BowlingClient />
      </>
    );
  }
  if (game.slug === "airhockey" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <AirHockeyClient />
      </>
    );
  }
  if (game.slug === "penalty" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <PenaltyClient />
      </>
    );
  }
  if (game.slug === "missile" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MissileClient />
      </>
    );
  }
  if (game.slug === "dragrace" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DragRaceClient />
      </>
    );
  }
  if (game.slug === "billiards" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BilliardsClient />
      </>
    );
  }
  if (game.slug === "curling" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CurlingClient />
      </>
    );
  }
  if (game.slug === "chesspuzzle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ChessPuzzleClient />
      </>
    );
  }
  if (game.slug === "balancestack" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BalanceStackClient />
      </>
    );
  }
  if (game.slug === "chinchiro" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ChinchiroClient />
      </>
    );
  }
  if (game.slug === "crocodile" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <CrocodileClient />
      </>
    );
  }
  if (game.slug === "kwordle" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <KwordleClient />
      </>
    );
  }
  if (game.slug === "worldbox" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WorldBoxClient />
      </>
    );
  }
  return (
    <>
      <GameDetailHeader game={game} />
      <div className="page-heading">
        <h1>{game.title}</h1>
        <p className="muted">{game.description}</p>
        <p className="quiet-note">このゲームは準備中です。</p>
      </div>
    </>
  );
}
