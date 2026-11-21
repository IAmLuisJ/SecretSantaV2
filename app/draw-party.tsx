import { useEffect, useEffectEvent, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";
import { WrappedGift } from "./holiday-art";

export function useDrawStatusRefresh(waitingForDraw: boolean, drawLocked: boolean) {
  const navigation = useNavigation();
  const { revalidate, state } = useRevalidator();
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "visible" && navigation.state === "idle" && state === "idle") {
      void revalidate();
    }
  });

  useEffect(() => {
    if (!waitingForDraw && !drawLocked) return;
    const onVisible = () => refresh();
    const timer = waitingForDraw ? window.setInterval(onVisible, 10_000) : undefined;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waitingForDraw, drawLocked]);
}

export function DrawPartyCountdown({ releaseAt, readAt }: { releaseAt: number; readAt: number }) {
  const navigation = useNavigation();
  const { revalidate } = useRevalidator();
  const [remaining, setRemaining] = useState(releaseAt - readAt);
  const [localReleaseLabel, setLocalReleaseLabel] = useState<string>();
  const releaseIso = new Date(releaseAt * 1000).toISOString();

  useEffect(() => {
    setLocalReleaseLabel(new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(releaseIso)));
  }, [releaseIso]);

  useEffect(() => {
    const deadline = Date.now() + (releaseAt - readAt) * 1000;
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [releaseAt, readAt]);

  useEffect(() => {
    // Run the release refresh independently of any pending form submission.
    if (remaining === 0 && navigation.state === "idle") void revalidate();
  }, [remaining, navigation.state, revalidate]);

  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor(remaining / 3600) % 24;
  const minutes = Math.floor(remaining / 60) % 60;
  const seconds = remaining % 60;

  return (
    <div className="reveal-waiting draw-party">
      <div>
        <h2>Draw Party</h2>
        <p className="draw-countdown" role="timer" aria-label="Time until matches open">
          {days > 0 && `${days}d `}{hours}h {minutes}m {seconds}s
        </p>
        <p>Matches open <time dateTime={releaseIso}>{localReleaseLabel ?? `${releaseIso.slice(0, 16).replace("T", " ")} UTC`}</time>.</p>
        <noscript><p>Refresh this page at the release time to unwrap your match.</p></noscript>
      </div>
      <WrappedGift />
    </div>
  );
}
