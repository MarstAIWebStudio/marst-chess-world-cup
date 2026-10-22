import { Chess, type Square } from "chess.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  db,
  firebaseReady,
  guestLogin,
  collection,
  doc,
  setDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from "./lib/firebase";
import { gradeMove, type MoveGrade } from "./lib/ratings";

type Player = {
  id: string;
  nickname: string;
  joinedAt: number;
};

type Match = {
  id: string;
  white: Player;
  black: Player | null;
  round: number;
  fen: string;
  pgn: string;
  moves: Array<{
    san: string;
    grade: MoveGrade;
    label: string;
    fen: string;
  }>;
  wins: { white: number; black: number };
  status: "waiting" | "playing" | "finished";
  result: "white" | "black" | "draw" | null;
};

type EngineResult = {
  score: number;
  bestMove: string;
  depth: number;
};

const STORAGE = {
  nickname: "marst-cwc-nickname",
  applications: "marst-cwc-applications",
  matches: "marst-cwc-matches",
};

const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const PIECES: Record<string, string> = {
  wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙",
  bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟",
};

const GRADES: Record<MoveGrade, string> = {
  "!!": "탁월",
  "!": "좋은 수",
  "?!": "부정확한 수",
  "!?": "흥미수",
  "?": "실수",
  "??": "블런더",
  "-": "기물 점수 유지",
  "📕": "이론수",
  "⭐": "최선수",
};

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function makeId() {
  return crypto.randomUUID();
}

function createMatches(players: Player[]): Match[] {
  const shuffled = shuffle(players);
  const matches: Match[] = [];

  for (let i = 0; i < shuffled.length; i += 2) {
    const white = shuffled[i];
    const black = shuffled[i + 1] ?? null;

    matches.push({
      id: makeId(),
      white,
      black,
      round: 1,
      fen: INITIAL_FEN,
      pgn: "",
      moves: [],
      wins: {
        white: black ? 0 : 2,
        black: 0,
      },
      status: black ? "waiting" : "finished",
      result: black ? null : "white",
    });
  }

  return matches;
}

function Board({
  game,
  selected,
  setSelected,
  onMove,
  disabled,
}: {
  game: Chess;
  selected: string | null;
  setSelected: (square: string | null) => void;
  onMove: (from: string, to: string) => void;
  disabled: boolean;
}) {
  const board = game.board();
  const legalTargets = useMemo(() => {
    if (!selected) return [];

    try {
      return game.moves({
        square: selected as Square,
        verbose: true,
      }).map((move) => move.to);
    } catch {
      return [];
    }
  }, [game, selected]);

  return (
    <div className="chessboard">
      {board.flatMap((row, rowIndex) =>
        row.map((piece, colIndex) => {
          const square =
            `${"abcdefgh"[colIndex]}${8 - rowIndex}`;

          const light = (rowIndex + colIndex) % 2 === 0;
          const isSelected = selected === square;
          const isTarget = legalTargets.includes(square);

          return (
            <button
              key={square}
              type="button"
              className={[
                "square",
                light ? "light-square" : "dark-square",
                isSelected ? "selected-square" : "",
                isTarget ? "target-square" : "",
              ].join(" ")}
              disabled={disabled}
              aria-label={square}
              onClick={() => {
                if (disabled) return;

                if (isTarget && selected) {
                  onMove(selected, square);
                  setSelected(null);
                  return;
                }

                if (piece) {
                  const color = piece.color;
                  const currentTurn = game.turn();

                  if (color === currentTurn) {
                    setSelected(square);
                    return;
                  }
                }

                setSelected(null);
              }}
            >
              {colIndex === 0 && (
                <span className="rank-label">
                  {8 - rowIndex}
                </span>
              )}

              {rowIndex === 7 && (
                <span className="file-label">
                  {"abcdefgh"[colIndex]}
                </span>
              )}

              {piece && (
                <span
                  className={
                    "piece " +
                    (piece.color === "w" ? "white-piece" : "black-piece")
                  }
                >
                  {PIECES[piece.color + piece.type]}
                </span>
              )}

              {!piece && isTarget && (
                <span className="move-dot" />
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

function StockfishPanel({
  fen,
  lastGrade,
}: {
  fen: string;
  lastGrade: MoveGrade | null;
}) {
  const workerRef = useRef<Worker | null>(null);
  const [engine, setEngine] = useState<EngineResult | null>(null);
  const [status, setStatus] = useState("엔진 준비 중");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!enabled) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setStatus("분석 중지");
      return;
    }

    let worker: Worker;

    try {
      worker = new Worker(
        "https://cdn.jsdelivr.net/npm/stockfish@17.1.0/stockfish-17.1-lite-single-03e3232.js"
      );
    } catch {
      setStatus("엔진을 불러오지 못했어");
      return;
    }

    workerRef.current = worker;
    setStatus("Stockfish 초기화 중");

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = String(event.data);

      if (line === "uciok") {
        worker.postMessage("isready");
      }

      if (line === "readyok") {
        setStatus("실시간 분석 중");
        worker.postMessage("ucinewgame");
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage("go depth 12");
      }

      if (line.startsWith("info ")) {
        const depthMatch = line.match(/\bdepth\s+(\d+)/);
        const scoreMatch = line.match(
          /\bscore\s+(cp|mate)\s+(-?\d+)/
        );

        if (scoreMatch) {
          const depth = Number(depthMatch?.[1] ?? 0);
          const value = Number(scoreMatch[2]);
          const turn = fen.split(" ")[1];

          let score = scoreMatch[1] === "mate"
            ? Math.sign(value) * 1000
            : value / 100;

          if (turn === "b") score *= -1;

          setEngine((previous) => ({
            score,
            bestMove: previous?.bestMove ?? "",
            depth,
          }));
        }
      }

      if (line.startsWith("bestmove ")) {
        const bestMove = line.split(/\s+/)[1];

        setEngine((previous) => ({
          score: previous?.score ?? 0,
          bestMove: bestMove === "(none)" ? "" : bestMove,
          depth: previous?.depth ?? 0,
        }));
      }
    };

    worker.onerror = () => {
      setStatus("엔진 로딩 실패 · 인터넷 연결을 확인해 줘");
    };

    worker.postMessage("uci");

    return () => {
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
    };
  }, [fen, enabled]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ENGINE ANALYSIS</span>
          <h3>Stockfish</h3>
        </div>

        <button
          className="small-button"
          onClick={() => setEnabled((value) => !value)}
        >
          {enabled ? "분석 중지" : "분석 시작"}
        </button>
      </div>

      <div className="engine-score">
        <span className="score-value">
          {engine
            ? engine.score > 0
              ? `+${engine.score.toFixed(2)}`
              : engine.score.toFixed(2)
            : "—"}
        </span>

        <span className="engine-status">{status}</span>
      </div>

      <div className="engine-meter">
        <div
          className="engine-meter-fill"
          style={{
            width: `${Math.max(
              5,
              Math.min(95, 50 + (engine?.score ?? 0) * 10)
            )}%`,
          }}
        />
      </div>

      <div className="engine-meta">
        <span>탐색 깊이: {engine?.depth ?? 0}</span>
        <span>추천 수: {engine?.bestMove || "계산 중"}</span>
      </div>

      {lastGrade && (
        <div className="last-grade">
          <span className="grade-symbol">{lastGrade}</span>
          <span>{GRADES[lastGrade]}</span>
        </div>
      )}

      <p className="muted small">
        엔진 평가는 분석 진행 중 변경될 수 있어.
      </p>
    </section>
  );
}

export default function App() {
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(STORAGE.nickname) ?? ""
  );

  const [draft, setDraft] = useState("");
  const [applications, setApplications] = useState<Player[]>(
    () => readLocal(STORAGE.applications, [])
  );

  const [matches, setMatches] = useState<Match[]>(
    () => readLocal(STORAGE.matches, [])
  );

  const [activeMatchId, setActiveMatchId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState("home");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const [roundLabel, setRoundLabel] = useState("참가 신청 진행 중");

  const activeMatch = matches.find(
    (match) => match.id === activeMatchId
  );

  const game = useMemo(() => {
    const chess = new Chess();

    if (activeMatch?.fen) {
      try {
        chess.load(activeMatch.fen);
      } catch {
        chess.reset();
      }
    }

    return chess;
  }, [activeMatch?.fen]);

  const currentPlayer = applications.find(
    (player) => player.nickname.toLowerCase() === nickname.toLowerCase()
  );

  useEffect(() => {
    saveLocal(STORAGE.applications, applications);
  }, [applications]);

  useEffect(() => {
    saveLocal(STORAGE.matches, matches);
  }, [matches]);

  useEffect(() => {
    if (!db) return;

    const stopApplications = onSnapshot(
      collection(db, "applications"),
      (snapshot) => {
        const next = snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Player, "id">),
        }));

        setApplications(next);
      },
      () => setNotice("신청 데이터 동기화에 실패했어.")
    );

    const stopMatches = onSnapshot(
      collection(db, "matches"),
      (snapshot) => {
        const next = snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Match, "id">),
        }));

        setMatches(next);
      },
      () => setNotice("대국 데이터 동기화에 실패했어.")
    );

    return () => {
      stopApplications();
      stopMatches();
    };
  }, []);

  const login = async () => {
    const value = draft.trim();

    if (value.length < 2 || value.length > 16) {
      setNotice("닉네임은 2~16자로 입력해 줘.");
      return;
    }

    setLoading(true);

    try {
      if (db) {
        await guestLogin();
      }

      const exists = applications.some(
        (player) =>
          player.nickname.toLowerCase() === value.toLowerCase() &&
          player.nickname !== nickname
      );

      if (exists) {
        setNotice("이미 사용 중인 닉네임이야.");
        return;
      }

      setNickname(value);
      localStorage.setItem(STORAGE.nickname, value);
      setNotice(`${value} 로그인 완료!`);
      setPage("home");
    } catch {
      setNotice("로그인에 실패했어. Firebase 설정을 확인해 줘.");
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!nickname) {
      setNotice("먼저 닉네임 로그인을 해 줘.");
      setPage("login");
      return;
    }

    if (applications.some((player) => player.id === nickname)) {
      setNotice("이미 신청했어!");
      return;
    }

    const player: Player = {
      id: nickname,
      nickname,
      joinedAt: Date.now(),
    };

    try {
      if (db) {
        await setDoc(doc(db, "applications", player.id), {
          nickname: player.nickname,
          joinedAt: player.joinedAt,
          createdAt: serverTimestamp(),
        });
      } else {
        setApplications((previous) => [...previous, player]);
      }

      setNotice("월드컵 참가 신청 완료! 🏆");
    } catch {
      setNotice("신청 저장에 실패했어.");
    }
  };

  const generateBracket = async () => {
    if (applications.length < 2) {
      setNotice("대진표를 만들려면 참가자가 최소 2명 필요해.");
      return;
    }

    if (matches.some((match) => match.status === "playing")) {
      setNotice("진행 중인 경기가 있어. 현재 경기를 먼저 끝내 줘.");
      return;
    }

    const nextMatches = createMatches(applications);

    try {
      if (db) {
        for (const match of nextMatches) {
          await setDoc(doc(db, "matches", match.id), match);
        }

        await setDoc(doc(db, "settings", "tournament"), {
          status: "playing",
          round: 1,
          generatedAt: serverTimestamp(),
        });
      }

      setMatches(nextMatches);
      setRoundLabel("1라운드");
      setPage("bracket");
      setNotice("랜덤 대진표를 생성했어!");
    } catch {
      setNotice("대진표 저장에 실패했어.");
    }
  };

  const playMove = useCallback(
    async (from: string, to: string) => {
      if (!activeMatch || activeMatch.status === "finished") return;

      if (!activeMatch.black) return;

      const isWhiteTurn = game.turn() === "w";
      const myNickname = nickname;

      if (
        (isWhiteTurn && activeMatch.white.nickname !== myNickname) ||
        (!isWhiteTurn && activeMatch.black.nickname !== myNickname)
      ) {
        setNotice("네 차례가 아니거나 이 경기의 선수가 아니야.");
        return;
      }

      const beforeGame = new Chess(activeMatch.fen);
      const beforeMaterial = Object.values(
        beforeGame.board().flat().reduce<Record<string, number>>(
          (acc, piece) => {
            if (piece) {
              const key = piece.color + piece.type;
              acc[key] = (acc[key] ?? 0) + 1;
            }
            return acc;
          },
          {}
        )
      ).reduce((sum, value) => sum + value, 0);

      const nextGame = new Chess(activeMatch.fen);

      try {
        nextGame.move({
          from: from as Square,
          to: to as Square,
          promotion: "q",
        });
      } catch {
        setNotice("불가능한 수야.");
        return;
      }

      const afterMaterial = Object.values(
        nextGame.board().flat().reduce<Record<string, number>>(
          (acc, piece) => {
            if (piece) {
              const key = piece.color + piece.type;
              acc[key] = (acc[key] ?? 0) + 1;
            }
            return acc;
          },
          {}
        )
      ).reduce((sum, value) => sum + value, 0);

      const san = nextGame.history().at(-1) ?? "";
      const lastMove = nextGame.history({ verbose: true }).at(-1);

      // 실제 엔진의 직전 최선 수와 비교하는 기능은
      // 아래 StockfishPanel의 엔진 결과와 통합할 때 사용한다.
      // 엔진 결과가 없을 때는 최선수나 실수라고 허위 판정하지 않는다.
      const grade: MoveGrade =
        beforeMaterial !== afterMaterial ? "?!" : "-";

      const move = {
        san,
        grade,
        label: GRADES[grade],
        fen: nextGame.fen(),
      };

      const isDraw = nextGame.isDraw();
      const isMate = nextGame.isCheckmate();
      const isFinished = isDraw || isMate;

      let wins = { ...activeMatch.wins };
      let result = activeMatch.result;
      let status: Match["status"] = isFinished ? "finished" : "playing";

      if (isMate) {
        if (nextGame.turn() === "w") wins.black += 1;
        else wins.white += 1;
      }

      if (wins.white >= 2) result = "white";
      else if (wins.black >= 2) result = "black";

      if (result || isDraw) status = "finished";

      const updated: Match = {
        ...activeMatch,
        fen: nextGame.fen(),
        pgn: nextGame.pgn(),
        moves: [...activeMatch.moves, move],
        wins,
        result,
        status,
      };

      try {
        if (db) {
          await setDoc(
            doc(db, "matches", updated.id),
            updated
          );
        }

        setMatches((previous) =>
          previous.map((item) =>
            item.id === updated.id ? updated : item
          )
        );

        if (isFinished && !result) {
          setNotice("무승부! 대회 규정에 따라 결과 처리가 필요해.");
        } else if (result) {
          setNotice(
            `경기 종료! ${
              result === "white"
                ? updated.white.nickname
                : updated.black?.nickname
            } 승리`
          );
        }
      } catch {
        setNotice("수 저장에 실패했어. 다시 연결해 줘.");
      }

      setSelected(null);
    },
    [activeMatch, game, nickname]
  );

  const openMatch = (match: Match) => {
    setActiveMatchId(match.id);
    setPage("match");
    setSelected(null);
  };

  return (
    <div className="app-shell">
      <header className="navbar">
        <button className="brand" onClick={() => setPage("home")}>
          <span className="brand-icon">♟</span>
          <span>
            <strong>MARST</strong>
            <small>CHESS WORLD CUP</small>
          </span>
        </button>

        <nav>
          <button onClick={() => setPage("home")}>홈</button>
          <button onClick={() => setPage("bracket")}>대진표</button>
          <button onClick={() => setPage("watch")}>관전</button>
        </nav>

        <button
          className="profile-button"
          onClick={() => setPage("login")}
        >
          {nickname || "닉네임 로그인"}
        </button>
      </header>

      <main>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>×</button>
          </div>
        )}

        {page === "home" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <div className="eyebrow">
                  THE NEXT MOVE IS YOURS
                </div>

                <h1>
                  당신의 한 수가
                  <br />
                  <span>월드 챔피언을 결정한다.</span>
                </h1>

                <p>
                  참가 신청부터 랜덤 대진표, 실시간 대국과
                  엔진 분석까지. 모든 승부가 이곳에서 시작돼.
                </p>

                <div className="hero-actions">
                  <button
                    className="primary-button"
                    onClick={() => {
                      if (!nickname) setPage("login");
                      else void apply();
                    }}
                  >
                    월드컵 신청하기 ↗
                  </button>

                  <button
                    className="secondary-button"
                    onClick={() => setPage("bracket")}
                  >
                    대진표 보기
                  </button>
                </div>
              </div>

              <div className="hero-art">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="hero-king">♔</div>
                <div className="hero-crown">WORLD CUP · 2026</div>
              </div>
            </section>

            <section className="stats-grid">
              <Stat
                number={applications.length.toString()}
                label="참가 신청"
              />
              <Stat
                number={matches.length.toString()}
                label="등록된 경기"
              />
              <Stat
                number={matches
                  .filter((match) => match.status === "finished")
                  .length.toString()}
                label="종료된 경기"
              />
              <Stat number="BO3" label="3판 2선승제" />
            </section>

            <section className="section-block">
              <div className="section-title">
                <div>
                  <span className="eyebrow">TOURNAMENT</span>
                  <h2>대회 안내</h2>
                </div>
                <span className="status-pill">
                  {roundLabel}
                </span>
              </div>

              <div className="feature-grid">
                <Feature
                  number="01"
                  title="참가 신청"
                  description="닉네임으로 참가 신청하고 대회 참가 명단에 이름을 올려."
                />
                <Feature
                  number="02"
                  title="랜덤 대진표"
                  description="참가 마감 후 무작위로 대진표를 생성하고 라운드를 진행해."
                />
                <Feature
                  number="03"
                  title="실시간 대국"
                  description="사이트에서 직접 경기하고 무르기 없이 승부를 결정해."
                />
                <Feature
                  number="04"
                  title="엔진 분석"
                  description="Stockfish 분석과 수 평가 기호로 모든 수를 확인해."
                />
              </div>
            </section>

            <section className="section-block">
              <div className="section-title">
                <div>
                  <span className="eyebrow">LIVE MATCHES</span>
                  <h2>진행 중인 경기</h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => setPage("watch")}
                >
                  전체 관전 →
                </button>
              </div>

              <div className="match-list">
                {matches.filter(
                  (match) => match.status !== "finished"
                ).length === 0 ? (
                  <div className="empty-state">
                    <span>♟</span>
                    <h3>아직 등록된 경기가 없어</h3>
                    <p>
                      참가자를 모집하고 대진표를 생성해 줘.
                    </p>
                  </div>
                ) : (
                  matches
                    .filter((match) => match.status !== "finished")
                    .map((match) => (
                      <MatchCard
                        key={match.id}
                        match={match}
                        onClick={() => openMatch(match)}
                      />
                    ))
                )}
              </div>
            </section>
          </>
        )}

        {page === "login" && (
          <section className="form-page">
            <span className="eyebrow">PLAYER REGISTRATION</span>
            <h1>플레이어 입장</h1>
            <p>사용할 닉네임을 입력해 줘.</p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void login();
              }}
            >
              <label htmlFor="nickname">닉네임</label>
              <input
                id="nickname"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="예: Marst"
                minLength={2}
                maxLength={16}
                required
              />
              <button
                className="primary-button"
                type="submit"
                disabled={loading}
              >
                {loading ? "입장 중..." : "닉네임으로 입장"}
              </button>
            </form>

            <p className="muted small">
              현재 닉네임은 이 브라우저에 저장돼.
              Firebase를 설정하면 익명 계정도 사용할 수 있어.
            </p>
          </section>
        )}

        {page === "bracket" && (
          <section className="section-block page-section">
            <div className="section-title">
              <div>
                <span className="eyebrow">KNOCKOUT STAGE</span>
                <h1>월드컵 대진표</h1>
                <p>3판 2선승제 · 랜덤 매칭</p>
              </div>

              <button
                className="primary-button"
                onClick={() => void generateBracket()}
              >
                랜덤 대진표 생성
              </button>
            </div>

            <div className="admin-warning">
              대진표 생성 버튼은 현재 개발용이야.
              공개 운영에서는 운영자 권한 검증이 필요해.
            </div>

            <div className="bracket-grid">
              {matches.map((match) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  onClick={() => openMatch(match)}
                />
              ))}
            </div>

            <div className="section-title">
              <div>
                <span className="eyebrow">REGISTERED PLAYERS</span>
                <h2>참가 신청자 ({applications.length})</h2>
              </div>
            </div>

            <div className="player-list">
              {applications.map((player, index) => (
                <div className="player-row" key={player.id}>
                  <span className="player-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{player.nickname}</span>
                  <span className="player-status">신청 완료</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {page === "match" && activeMatch && (
          <section className="game-page">
            <div className="game-topbar">
              <button
                className="text-button"
                onClick={() => setPage("bracket")}
              >
                ← 대진표
              </button>
              <span className="live-pill">
                {activeMatch.status === "finished"
                  ? "경기 종료"
                  : activeMatch.status === "playing"
                    ? "LIVE"
                    : "대기 중"}
              </span>
            </div>

            <div className="game-layout">
              <section className="board-column">
                <div className="player-strip">
                  <span className="player-avatar">♟</span>
                  <div className="player-info">
                    <strong>{activeMatch.black?.nickname ?? "부전승"}</strong>
                    <span>흑 · Black</span>
                  </div>
                  <strong className="game-score">
                    {activeMatch.wins.black}
                  </strong>
                </div>

                <Board
                  game={game}
                  selected={selected}
                  setSelected={setSelected}
                  onMove={(from, to) => void playMove(from, to)}
                  disabled={
                    activeMatch.status === "finished" ||
                    !activeMatch.black
                  }
                />

                <div className="player-strip">
                  <span className="player-avatar white-avatar">♙</span>
                  <div className="player-info">
                    <strong>{activeMatch.white.nickname}</strong>
                    <span>백 · White</span>
                  </div>
                  <strong className="game-score">
                    {activeMatch.wins.white}
                  </strong>
                </div>

                <div className="game-actions">
                  <span className="muted small">
                    {game.isCheckmate()
                      ? "체크메이트"
                      : game.isDraw()
                        ? "무승부"
                        : game.turn() === "w"
                          ? "백 차례"
                          : "흑 차례"}
                  </span>
                  <span className="muted small">
                    무르기 비활성화
                  </span>
                </div>
              </section>

              <aside className="game-sidebar">
                <StockfishPanel
                  fen={activeMatch.fen}
                  lastGrade={
                    activeMatch.moves.at(-1)?.grade ?? null
                  }
                />

                <section className="panel">
                  <div className="panel-heading">
                    <h3>경기 기보</h3>
                    <span className="muted small">
                      {activeMatch.moves.length}수
                    </span>
                  </div>

                  <div className="move-history">
                    {activeMatch.moves.length === 0 ? (
                      <p className="muted">
                        첫 수를 기다리는 중...
                      </p>
                    ) : (
                      activeMatch.moves.map((move, index) => (
                        <div className="move-row" key={`${index}-${move.fen}`}>
                          <span>{index + 1}.</span>
                          <strong>{move.san}</strong>
                          <span
                            className={`grade grade-${move.grade.replace(
                              /[^a-zA-Z0-9]/g,
                              ""
                            )}`}
                          >
                            {move.grade}
                          </span>
                          <span className="muted small">
                            {move.label}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </section>
        )}

        {page === "watch" && (
          <section className="section-block page-section">
            <span className="eyebrow">SPECTATOR ARENA</span>
            <h1>실시간 관전</h1>
            <p className="muted">
              경기를 선택하면 체스판과 분석 패널을 볼 수 있어.
            </p>

            <div className="match-list">
              {matches.length === 0 ? (
                <div className="empty-state">
                  <span>◉</span>
                  <h3>관전 가능한 경기가 없어</h3>
                  <p>대진표가 생성되면 여기에 표시돼.</p>
                </div>
              ) : (
                matches.map((match) => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    onClick={() => openMatch(match)}
                  />
                ))
              )}
            </div>
          </section>
        )}
      </main>

      <footer>
        <div className="footer-brand">♟ MARST</div>
        <p>Every move matters.</p>
        <span>
          {firebaseReady
            ? "Firebase 연결 설정 감지"
            : "로컬 개발 모드 · Firebase 미설정"}
        </span>
      </footer>
    </div>
  );
}

function Stat({
  number,
  label,
}: {
  number: string;
  label: string;
}) {
  return (
    <div className="stat-card">
      <strong>{number}</strong>
      <span>{label}</span>
    </div>
  );
}

function Feature({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <article className="feature-card">
      <span>{number}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  );
}

function MatchCard({
  match,
  onClick,
}: {
  match: Match;
  onClick: () => void;
}) {
  return (
    <button className="match-card" onClick={onClick}>
      <div className="match-player">
        <span className="player-color white-color" />
        <span>{match.white.nickname}</span>
        <strong>{match.wins.white}</strong>
      </div>

      <div className="match-player">
        <span className="player-color black-color" />
        <span>{match.black?.nickname ?? "부전승"}</span>
        <strong>{match.wins.black}</strong>
      </div>

      <div className="match-card-footer">
        <span>ROUND {match.round}</span>
        <span>
          {match.status === "finished"
            ? "종료"
            : match.status === "playing"
              ? "실시간 경기"
              : "경기 대기"}
        </span>
        <span>관전 →</span>
      </div>
    </button>
  );
}
