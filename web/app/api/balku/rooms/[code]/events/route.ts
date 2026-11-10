import { BalkuRoomError, parsePlayerToken, parseRoomCode, subscribeBalkuRoom } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * SSE（主同期経路）。接続直後に現行スナップショットを送り、以後は
 * そのルームの revision が上がるたびに新しいスナップショットを送る。
 * 15秒ごとの heartbeat コメントで接続を維持する。
 * Next の常駐サーバー（Pi）前提で、切断時は購読を確実に解除する。
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  let code: string;
  let token: string;
  try {
    code = parseRoomCode((await params).code);
    token = parsePlayerToken(new URL(request.url).searchParams.get("token"));
  } catch (error) {
    const message = error instanceof BalkuRoomError ? error.message : "リクエストが正しくありません";
    const status = error instanceof BalkuRoomError ? error.status : 400;
    return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendRaw = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      try {
        const subscription = await subscribeBalkuRoom(code, token, (view) => {
          sendRaw(`data: ${JSON.stringify(view)}\n\n`);
        });
        unsubscribe = subscription.unsubscribe;
        if (closed) {
          unsubscribe();
          return;
        }
        sendRaw(`data: ${JSON.stringify(subscription.view)}\n\n`);
        heartbeat = setInterval(() => sendRaw(": heartbeat\n\n"), HEARTBEAT_MS);
      } catch (error) {
        const message = error instanceof BalkuRoomError ? error.message : "ルームを取得できませんでした";
        sendRaw(`event: room-error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        closed = true;
        try {
          controller.close();
        } catch {
          // 既に閉じている
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  // クライアント切断（タブを閉じる等）でも購読解除と heartbeat 停止を保証する
  request.signal.addEventListener("abort", () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
