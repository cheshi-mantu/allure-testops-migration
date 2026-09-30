import type { Profile, SourceDiscovery, TestOpsDiscovery } from "@atm/shared";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "../api/client";

export type SaveState = "saved" | "pending" | "saving" | "error";

interface ProfileContextValue {
  profile: Profile;
  /** Applies a change to a copy of the profile; the result is saved automatically. */
  update: (change: (draft: Profile) => void) => void;
  /** Saves pending changes now; call before asking the server to use the profile. */
  flush: () => Promise<void>;
  saveState: SaveState;
  saveError: string | null;
  /** Structure, fields and sample cases of the source (TestRail or CSV file). */
  source: UseQueryResult<SourceDiscovery>;
  testops: UseQueryResult<TestOpsDiscovery>;
  /** Saves, then reloads discovery data of both systems. */
  refreshDiscovery: (which?: "source" | "testops" | "both") => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfile outside ProfileProvider");
  }
  return value;
}

const SAVE_DELAY_MS = 700;

export function ProfileProvider({ initial, children }: { initial: Profile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef(profile);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);

  const save = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saving.current) {
      await saving.current;
    }
    if (!dirty.current) {
      return;
    }
    dirty.current = false;
    setSaveState("saving");
    saving.current = api
      .saveProfile(latest.current)
      .then(() => {
        setSaveState(dirty.current ? "pending" : "saved");
        setSaveError(null);
        void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      })
      .catch((error: unknown) => {
        dirty.current = true;
        setSaveState("error");
        setSaveError(errorText(error));
      })
      .finally(() => {
        saving.current = null;
      });
    await saving.current;
  }, [queryClient]);

  const update = useCallback(
    (change: (draft: Profile) => void) => {
      const next = structuredClone(latest.current);
      change(next);
      latest.current = next;
      setProfile(next);
      dirty.current = true;
      setSaveState("pending");
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
    },
    [save],
  );

  // Save on leave.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        void save();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      void save();
    };
  }, [save]);

  const source = useQuery({
    queryKey: ["discovery", "source", profile.id],
    queryFn: () => api.discoverSource(profile.id),
    enabled: false,
    staleTime: Infinity,
  });
  const testops = useQuery({
    queryKey: ["discovery", "testops", profile.id],
    queryFn: () => api.discoverTestOps(profile.id),
    enabled: false,
    staleTime: Infinity,
  });

  const refreshDiscovery = useCallback(
    async (which: "source" | "testops" | "both" = "both") => {
      await save();
      const jobs: Promise<unknown>[] = [];
      if (which !== "testops") {
        jobs.push(source.refetch());
      }
      if (which !== "source") {
        jobs.push(testops.refetch());
      }
      await Promise.all(jobs);
    },
    [save, source, testops],
  );

  const value = useMemo(
    () => ({ profile, update, flush: save, saveState, saveError, source, testops, refreshDiscovery }),
    [profile, update, save, saveState, saveError, source, testops, refreshDiscovery],
  );
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}
