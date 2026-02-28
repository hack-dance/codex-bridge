"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardSnapshot } from "@/lib/dashboard-data";

const POLL_INTERVAL_MS = 15_000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 12_000;

export const loadSnapshot = async (): Promise<DashboardSnapshot> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, SNAPSHOT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch("/api/snapshot", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Snapshot fetch failed (${response.status})`);
    }
    return (await response.json()) as DashboardSnapshot;
  } catch (requestError) {
    const isAbortError =
      requestError instanceof DOMException &&
      requestError.name === "AbortError";
    if (isAbortError) {
      throw new Error("Snapshot request timed out");
    }
    throw requestError;
  } finally {
    clearTimeout(timeout);
  }
};

export const runDashboardAction = async ({
  payload,
}: {
  payload: Record<string, unknown>;
}): Promise<unknown> => {
  const response = await fetch("/api/actions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : `Action failed (${response.status})`;
    throw new Error(message);
  }
  return data;
};

export const useDashboardSnapshot = () => {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestInFlightRef = useRef(false);

  const refreshSnapshot = useCallback(
    async ({ isPoll }: { isPoll: boolean }) => {
      if (requestInFlightRef.current) {
        return;
      }
      requestInFlightRef.current = true;
      try {
        if (isPoll) {
          setIsRefreshing(true);
        } else {
          setIsLoading(true);
        }
        const nextSnapshot = await loadSnapshot();
        setSnapshot(nextSnapshot);
        setError(null);
      } catch (requestError) {
        const message =
          requestError instanceof Error
            ? requestError.message
            : "Failed to load dashboard snapshot";
        setError(message);
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
        requestInFlightRef.current = false;
      }
    },
    []
  );

  useEffect(() => {
    refreshSnapshot({ isPoll: false }).catch(() => undefined);
    const timer = setInterval(() => {
      refreshSnapshot({ isPoll: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshSnapshot]);

  return {
    snapshot,
    error,
    isLoading,
    isRefreshing,
    refreshSnapshot,
  };
};
