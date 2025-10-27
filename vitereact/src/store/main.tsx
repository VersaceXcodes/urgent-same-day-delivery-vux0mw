import { configureStore, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { persistStore, persistReducer } from "redux-persist";
import storage from "redux-persist/lib/storage";
import { createStateSyncMiddleware, initMessageListener } from "redux-state-sync";
import { io, Socket } from "socket.io-client";
import { useDispatch } from "react-redux";

// Define a type for the slice state
interface AuthState {
  token: string | null;
}

interface UserState {
  id: string | null;
  name: string | null;
}

interface RealTimeState {
  socket: Socket | null;
  connected: boolean;
}

interface AppState {
  auth: AuthState;
  user: UserState;
  realtime: RealTimeState;
}

const initialAuthState: AuthState = {
  token: null,
};

const initialUserState: UserState = {
  id: null,
  name: null,
};

const initialRealTimeState: RealTimeState = {
  socket: null,
  connected: false,
};

// Create slice for auth
const authSlice = createSlice({
  name: 'auth',
  initialState: initialAuthState,
  reducers: {
    setToken(state, action: PayloadAction<string | null>) {
      state.token = action.payload;
    },
    clearToken(state) {
      state.token = null;
    },
  },
});

// Create slice for user
const userSlice = createSlice({
  name: 'user',
  initialState: initialUserState,
  reducers: {
    setUser(state, action: PayloadAction<{id: string; name: string}>) {
      state.id = action.payload.id;
      state.name = action.payload.name;
    },
    clearUser(state) {
      state.id = null;
      state.name = null;
    },
  },
});

// Create slice for real-time capabilities
const realtimeSlice = createSlice({
  name: 'realtime',
  initialState: initialRealTimeState,
  reducers: {
    connectSocket(state) {
      if (!state.socket) {
        state.socket = io(import.meta.env.VITE_API_BASE_URL as string);
        state.connected = true;
      }
    },
    disconnectSocket(state) {
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
        state.connected = false;
      }
    },
  },
});

// Configure redux-persist
const persistConfig = {
  key: 'root',
  storage,
  whitelist: ['auth'] // persist only the auth state
};

const persistedAuthReducer = persistReducer(persistConfig, authSlice.reducer);

const rootReducer = {
  auth: persistedAuthReducer,
  user: userSlice.reducer,
  realtime: realtimeSlice.reducer,
};

// Configure store
const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }).concat(createStateSyncMiddleware()),
});

initMessageListener(store);

export const persistor = persistStore(store);

export const { setToken, clearToken } = authSlice.actions;
export const { setUser, clearUser } = userSlice.actions;
export const { connectSocket, disconnectSocket } = realtimeSlice.actions;

export const useAppDispatch = () => useDispatch<typeof store.dispatch>();

export default store;