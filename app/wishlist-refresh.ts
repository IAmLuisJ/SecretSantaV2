import { useEffect, useEffectEvent } from "react";
import { useNavigation, useRevalidator } from "react-router";

export function useWishlistRefresh() {
  const navigation = useNavigation();
  const { revalidate, state } = useRevalidator();
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "visible" && navigation.state === "idle" && state === "idle") {
      void revalidate();
    }
  });

  useEffect(() => {
    const onReturn = () => refresh();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
}
