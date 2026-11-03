import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  emptyProfile,
  getProfile,
  saveProfile,
  type Profile,
} from "@/lib/database/knowledge.action";

import {
  ACTIVE_SESSION_KEY,
  readActiveSessionId,
} from "@/lib/context/active-session";
export {
  ACTIVE_SESSION_KEY,
  readActiveSessionId,
} from "@/lib/context/active-session";
const ProfileContext = createContext<{
  profile: Profile;
  activeSessionId: string | null;
  error: string;
  refresh: () => Promise<void>;
  updateProfile: (value: Profile) => Promise<void>;
  activateSession: (id: string | null) => Promise<void>;
} | null>(null);
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [activeSessionId, setActiveSessionId] = useState(readActiveSessionId);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setProfile(await getProfile());
      setActiveSessionId(readActiveSessionId());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    void invoke("kb_warm").catch(() => {});
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    for (const event of ["active-session-changed", "profile-changed"]) {
      void listen(event, () => {
        void refresh();
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => {});
    }
    const onStorage = () => {
      void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
  }, [refresh]);
  const updateProfile = async (value: Profile) => {
    await saveProfile(value);
    setProfile(value);
    await emit("profile-changed").catch(() => {});
  };
  const activateSession = async (id: string | null) => {
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
    setActiveSessionId(id);
    await emit("active-session-changed", id);
  };
  return (
    <ProfileContext.Provider
      value={{
        profile,
        activeSessionId,
        error,
        refresh,
        updateProfile,
        activateSession,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}
export function useProfile() {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("ProfileProvider is required");
  return value;
}
