
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
// @ts-ignore
import { initializeApp, getApps, getApp, deleteApp } from 'firebase/app';
// @ts-ignore
import { getFirestore, doc, onSnapshot, setDoc, getDoc } from 'firebase/firestore';
// @ts-ignore
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// --- Types ---
interface TripItem {
  time: string;
  type: 'spot' | 'food' | 'shop' | 'transport' | 'flight';
  activity: string;
  location: string;
  note: string;
}

interface FlightInfo {
  startTime: string;
  startAirport: string;
  number: string;
  endTime: string;
  endAirport: string;
  arrivalOffset: number; // 0, 1, -1
}

interface DayPlan {
  date: string;
  shortDate: string;
  fullDate: string; // YYYY-MM-DD
  title: string;
  items: TripItem[];
  flight: FlightInfo | null;
}

interface Expense {
  item: string;
  amount: number;
  payer: string;
  isSettled?: boolean;
}

interface ShoppingItem {
  id: string;
  name: string;
  isBought: boolean;
  category: string;
  owner: string;
}

interface TripMeta {
  id: string;
  destination: string;
  startDate: string;
  daysCount: number;
}

interface SetupConfig {
  destination: string;
  startDate: string;
  days: number;
  rate: number;
  currency: string;
  langCode: string;
  langName: string;
}

// --- Constants & Helpers ---
// Pre-configured Firebase Config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBOSs5hcduO7f2a61KtMdFf44WoLVEYGP4",
  authDomain: "my-korea-trip.firebaseapp.com",
  projectId: "my-korea-trip",
  storageBucket: "my-korea-trip.firebasestorage.app",
  messagingSenderId: "753099310498",
  appId: "1:753099310498:web:b5007cc84efcd94ee31efb",
  measurementId: "G-CWEVNWQ4WS"
};

const generateId = () => 'trip_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

const getWeatherIcon = (c: number) => {
  if (c === 0) return 'ph-sun';
  if (c < 4) return 'ph-cloud-sun';
  if (c < 50) return 'ph-cloud-fog';
  if (c < 70) return 'ph-cloud-rain';
  return 'ph-cloud';
};

const getTimePeriod = (t: string) => {
  if (!t) return '時間';
  const h = parseInt(t.split(':')[0]);
  return h < 5 ? '凌晨' : h < 11 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
};

const getDotColor = (t: string) => 
  t === 'food' ? 'bg-orange-400' : t === 'shop' ? 'bg-pink-400' : t === 'flight' ? 'bg-blue-500' : 'bg-teal-500';

const countryInfoMap: Record<string, {c: string, l: string, n: string}> = { 
  'jp': {c:'JPY',l:'ja',n:'日文'}, 
  'kr': {c:'KRW',l:'ko',n:'韓文'}, 
  'us': {c:'USD',l:'en',n:'英文'}, 
  'cn': {c:'CNY',l:'zh-CN',n:'簡中'}, 
  'th': {c:'THB',l:'th',n:'泰文'} 
};

// Hook for debouncing values
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// --- Components ---

export default function App() {
  // State
  const [viewMode, setViewMode] = useState<'plan' | 'map' | 'money' | 'shopping' | 'translate'>('plan');
  const [currentDayIdx, setCurrentDayIdx] = useState(0);
  
  // Data
  const [days, setDays] = useState<DayPlan[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [shoppingList, setShoppingList] = useState<ShoppingItem[]>([]);
  const [participants, setParticipants] = useState(['我', '旅伴A']);
  const [exchangeRate, setExchangeRate] = useState(0.215);
  const [shoppingCategories, setShoppingCategories] = useState<string[]>(['藥妝', '零食', '伴手禮', '衣物', '電器']);

  // Trip Management
  const [tripList, setTripList] = useState<TripMeta[]>([]);
  const [currentTripId, setCurrentTripId] = useState<string | null>(null);
  const [showTripMenu, setShowTripMenu] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  
  // Cloud Sync State
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [firebaseConfigStr, setFirebaseConfigStr] = useState(JSON.stringify(FIREBASE_CONFIG, null, 2));
  const [db, setDb] = useState<any>(null);
  const [syncStatus, setSyncStatus] = useState<'offline' | 'connecting' | 'synced' | 'error'>('offline');
  const [userUid, setUserUid] = useState<string | null>(null);

  // Sync Loop Prevention
  const isRemoteUpdate = useRef(false);

  // Auto Join State
  const [pendingShareId, setPendingShareId] = useState<string | null>(null);

  // Temp UI State
  const [newExpense, setNewExpense] = useState({ item: '', amount: '', payer: '我' });
  const [participantsStr, setParticipantsStr] = useState('我, 旅伴A');
  const [newShoppingItem, setNewShoppingItem] = useState({ name: '', category: '藥妝', owner: '我' });
  const [joinTripId, setJoinTripId] = useState('');

  // Default Setup Configuration
  const defaultSetup: SetupConfig = { 
    destination: 'Seoul', 
    startDate: new Date().toISOString().split('T')[0], 
    days: 5, 
    rate: 0.022, 
    currency: 'KRW', 
    langCode: 'ko', 
    langName: '韓文' 
  };
  
  const [setup, setSetup] = useState<SetupConfig>(defaultSetup);
  
  // Async Data
  const [isRateLoading, setIsRateLoading] = useState(false);
  const [weather, setWeather] = useState<{temp: number | null, icon: string, location: string, daily: any}>({ temp: null, icon: 'ph-sun', location: '', daily: null });
  const [recommendations, setRecommendations] = useState<Record<string, {name: string, location: string}[]>>({});
  const [isSearchingRecs, setIsSearchingRecs] = useState(false);
  const [searchTargetIndex, setSearchTargetIndex] = useState('');
  
  // Map
  const mapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{lat: number, lng: number} | null>(null);

  const currentDay = days[currentDayIdx] || { items: [], flight: null, date: '', fullDate: '', title: '' };

  // --- Debounced Values for Cloud Sync ---
  const debouncedDays = useDebounce(days, 1000);
  const debouncedExpenses = useDebounce(expenses, 1000);
  const debouncedShopping = useDebounce(shoppingList, 1000);
  const debouncedSetup = useDebounce(setup, 1000);
  const debouncedParts = useDebounce(participants, 1000);
  const debouncedCats = useDebounce(shoppingCategories, 1000);
  const debouncedRate = useDebounce(exchangeRate, 1000);

  // --- Persistence (Local) ---

  useEffect(() => {
    const list = localStorage.getItem('travel_app_index');
    const parsedList = list ? JSON.parse(list) : [];
    setTripList(parsedList);
    
    // Auto Connect using hardcoded config automatically
    initFirebase(null, FIREBASE_CONFIG);

    // Check for shared URL
    const params = new URLSearchParams(window.location.search);
    const sharedId = params.get('tripId');
    if (sharedId) {
      setPendingShareId(sharedId);
      setJoinTripId(sharedId);
      // We don't show the modal immediately, we try to join in the background first
      setSyncStatus('connecting');
    } else {
      if (parsedList.length > 0) {
        switchTrip(parsedList[0].id);
      } else {
        setShowSetupModal(true);
      }
    }
  }, []);

  // Effect to Auto-Join once DB is ready
  useEffect(() => {
    if (db && userUid && pendingShareId) {
      joinTrip(pendingShareId);
      setPendingShareId(null); // Clear pending so we don't join again
    }
  }, [db, userUid, pendingShareId]);

  useEffect(() => {
    if (!currentTripId) return;
    // Don't overwrite local storage with empty data if we are loading
    if (days.length === 0 && !setup.destination) return; 

    localStorage.setItem(`${currentTripId}_days`, JSON.stringify(days));
    localStorage.setItem(`${currentTripId}_exp`, JSON.stringify(expenses));
    localStorage.setItem(`${currentTripId}_shop`, JSON.stringify(shoppingList));
    localStorage.setItem(`${currentTripId}_shop_cats`, JSON.stringify(shoppingCategories));
    localStorage.setItem(`${currentTripId}_rate`, exchangeRate.toString());
    localStorage.setItem(`${currentTripId}_users`, participantsStr);
    localStorage.setItem(`${currentTripId}_config`, JSON.stringify(setup));
  }, [days, expenses, shoppingList, shoppingCategories, exchangeRate, participantsStr, setup, currentTripId]);

  useEffect(() => {
    if (tripList.length > 0) {
       localStorage.setItem('travel_app_index', JSON.stringify(tripList));
    }
  }, [tripList]);

  // --- Firebase Logic ---

  const initFirebase = async (inputStr: string | null, directConfig?: any) => {
    try {
      setSyncStatus('connecting');
      let config = directConfig;

      if (!config && inputStr) {
        try {
            // Robust parsing strategy:
            // 1. Find the outermost curly braces to isolate the object definition
            const firstOpen = inputStr.indexOf('{');
            const lastClose = inputStr.lastIndexOf('}');

            if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
                const candidate = inputStr.substring(firstOpen, lastClose + 1);
                
                // 2. Try strict JSON parsing first (safe)
                try {
                    config = JSON.parse(candidate);
                } catch (e) {
                    // 3. If that fails (e.g. unquoted keys), evaluate as a JavaScript expression
                    // using new Function is safer than eval() but still allows JS object literals
                    config = new Function(`return ${candidate}`)();
                }
            } else {
                 throw new Error("Cannot find object braces {} in input");
            }
        } catch (e) {
            console.error("Parse Error:", e);
            // If all else fails, show error
            config = null;
        }
      }

      if (!config) {
         setSyncStatus('error');
         return;
      }

      // --- CRITICAL FIX ---
      // If an app instance already exists, we MUST delete it before re-initializing
      // otherwise Firebase will return the existing (broken/old) instance.
      if (getApps().length > 0) {
         try {
           await deleteApp(getApp());
         } catch(e) {
           console.warn("Error deleting existing app, force proceeding", e);
         }
      }

      const app = initializeApp(config);
      
      const auth = getAuth(app);
      
      // Anonymous Auth is Critical for Firestore Rules
      await signInAnonymously(auth);
      
      onAuthStateChanged(auth, (user: any) => {
        if (user) {
          setUserUid(user.uid);
          const firestore = getFirestore(app);
          setDb(firestore);
          setSyncStatus('synced');
        } else {
          setSyncStatus('error');
        }
      });

    } catch (e) {
      console.error("Firebase Init Error", e);
      setSyncStatus('error');
    }
  };

  const handleConnectCloud = () => {
    initFirebase(firebaseConfigStr);
  };

  // Sync: Listen for Remote Changes
  useEffect(() => {
    if (!db || !currentTripId) return;

    const unsub = onSnapshot(doc(db, "trips", currentTripId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        
        // --- Critical: Loop Prevention ---
        // We set a flag to ignore the next save triggered by this state change
        isRemoteUpdate.current = true;

        if (data.days) setDays(data.days);
        if (data.expenses) setExpenses(data.expenses);
        if (data.shoppingList) setShoppingList(data.shoppingList);
        if (data.setup) setSetup(data.setup);
        if (data.participants) {
           setParticipants(data.participants);
           setParticipantsStr(data.participants.join(', '));
        }
        if (data.shoppingCategories) setShoppingCategories(data.shoppingCategories);
        if (data.exchangeRate) setExchangeRate(data.exchangeRate);
        
        // Reset the flag after the debounce period + buffer
        // This ensures that when the "Write" useEffect fires due to these changes,
        // it sees the flag and aborts the write.
        setTimeout(() => {
          isRemoteUpdate.current = false;
        }, 1200);
      }
    });

    return () => unsub();
  }, [db, currentTripId]);

  // Sync: Push Local Changes
  useEffect(() => {
    if (!db || !currentTripId || syncStatus !== 'synced') return;
    
    // If this update was caused by a remote fetch, DO NOT WRITE BACK
    if (isRemoteUpdate.current) {
      return;
    }

    const pushData = async () => {
      try {
        await setDoc(doc(db, "trips", currentTripId), {
           days: debouncedDays,
           expenses: debouncedExpenses,
           shoppingList: debouncedShopping,
           setup: debouncedSetup,
           participants: debouncedParts,
           shoppingCategories: debouncedCats,
           exchangeRate: debouncedRate,
           lastUpdated: Date.now(),
           updatedBy: userUid
        }, { merge: true });
      } catch (e) {
        console.error("Sync push error", e);
      }
    };

    pushData();
  }, [debouncedDays, debouncedExpenses, debouncedShopping, debouncedSetup, debouncedParts, debouncedCats, debouncedRate, db, currentTripId, syncStatus, userUid]);

  const joinTrip = async (targetId?: string) => {
     if (!db) return; // Wait for DB
     
     const idToJoin = targetId || joinTripId;
     if (!idToJoin) return;

     setSyncStatus('connecting');
     try {
       const docRef = doc(db, "trips", idToJoin);
       const docSnap = await getDoc(docRef);
       
       if (docSnap.exists()) {
         const data = docSnap.data();
         const exists = tripList.find(t => t.id === idToJoin);
         
         if (!exists) {
           const newMeta: TripMeta = {
             id: idToJoin,
             destination: data.setup?.destination || '雲端行程',
             startDate: data.setup?.startDate || '',
             daysCount: data.setup?.days || 1
           };
           setTripList(prev => [newMeta, ...prev]);
         }
         
         // Set immediate values from cloud to prevent empty flash
         if (data.setup) setSetup(data.setup);
         if (data.days) setDays(data.days);

         switchTrip(idToJoin);
         setSyncStatus('synced');
         setShowCloudModal(false);
         setJoinTripId('');
         
         // Clear URL param if present to keep URL clean
         if (window.history.pushState) {
             const newurl = window.location.protocol + "//" + window.location.host + window.location.pathname;
             window.history.pushState({path:newurl},'',newurl);
         }
       } else {
         alert("找不到此行程 ID，請確認連結是否正確。");
         setSyncStatus('synced');
       }
     } catch (e) {
       console.error(e);
       alert("加入失敗，請檢查網路或 ID。");
       setSyncStatus('error');
     }
  };

  const copyShareLink = () => {
      if (!currentTripId) return;
      const url = `${window.location.origin}${window.location.pathname}?tripId=${currentTripId}`;
      navigator.clipboard.writeText(url);
      alert('邀請連結已複製！\n傳送給朋友，他們點開即可直接加入行程。');
  };

  // --- Methods ---

  const switchTrip = (id: string) => {
    setCurrentTripId(id);
    setShowTripMenu(false);
    
    // Try to load local first for speed
    const lDays = localStorage.getItem(`${id}_days`);
    const lExp = localStorage.getItem(`${id}_exp`);
    const lShop = localStorage.getItem(`${id}_shop`);
    const lShopCats = localStorage.getItem(`${id}_shop_cats`);
    const lUsers = localStorage.getItem(`${id}_users`);
    const lRate = localStorage.getItem(`${id}_rate`);
    const lConf = localStorage.getItem(`${id}_config`);

    if (lDays) setDays(JSON.parse(lDays));
    if (lExp) setExpenses(JSON.parse(lExp));
    
    if (lShop) {
      const items = JSON.parse(lShop);
      const migratedItems = items.map((i: any) => ({
        ...i,
        category: i.category || '未分類',
        owner: i.owner || '我'
      }));
      setShoppingList(migratedItems);
    } else {
      setShoppingList([]);
    }

    if (lShopCats) setShoppingCategories(JSON.parse(lShopCats));
    else setShoppingCategories(['藥妝', '零食', '伴手禮', '衣物', '電器']);

    if (lUsers) {
      setParticipantsStr(lUsers);
      setParticipants(lUsers.split(',').map(s => s.trim()).filter(Boolean));
    }
    if (lRate) setExchangeRate(parseFloat(lRate));
    if (lConf) {
      const conf = JSON.parse(lConf);
      setSetup(conf);
      fetchWeather(conf.destination);
    }
  };

  const createTrip = () => {
    if (!setup.destination) return alert('請輸入目的地');
    
    const newId = generateId();
    const newTripMeta = { 
      id: newId, 
      destination: setup.destination, 
      startDate: setup.startDate, 
      daysCount: setup.days 
    };

    const newDays: DayPlan[] = [];
    const start = new Date(setup.startDate);
    const dNames = ['日','一','二','三','四','五','六'];
    
    for(let i = 0; i < setup.days; i++) {
        const curr = new Date(start); 
        curr.setDate(start.getDate() + i);
        const mm = curr.getMonth() + 1; 
        const dd = curr.getDate();
        const yyyy = curr.getFullYear();
        const fullDate = `${yyyy}-${mm < 10 ? '0'+mm : mm}-${dd < 10 ? '0'+dd : dd}`;
        
        newDays.push({
            date: `${mm < 10 ? '0'+mm : mm}/${dd < 10 ? '0'+dd : dd} (${dNames[curr.getDay()]})`,
            shortDate: `${mm}/${dd}`,
            fullDate: fullDate,
            title: i === 0 ? '抵達 & 探索' : '行程規劃',
            items: [], 
            flight: null
        });
    }

    // Save initial state
    localStorage.setItem(`${newId}_days`, JSON.stringify(newDays));
    localStorage.setItem(`${newId}_exp`, '[]');
    localStorage.setItem(`${newId}_shop`, '[]');
    localStorage.setItem(`${newId}_shop_cats`, JSON.stringify(['藥妝', '零食', '伴手禮', '衣物', '電器']));
    localStorage.setItem(`${newId}_users`, '我, 旅伴A');
    localStorage.setItem(`${newId}_rate`, setup.rate.toString());
    localStorage.setItem(`${newId}_config`, JSON.stringify(setup));

    setDays(newDays);
    setExpenses([]);
    setShoppingList([]);
    setParticipants(['我', '旅伴A']);
    setParticipantsStr('我, 旅伴A');

    setTripList(prev => [newTripMeta, ...prev]);
    setCurrentTripId(newId); // Set ID directly to trigger sync
    setShowSetupModal(false);
  };

  const deleteTrip = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('確定刪除此行程？無法復原。')) return;
    
    const newList = tripList.filter(t => t.id !== id);
    setTripList(newList);
    localStorage.setItem('travel_app_index', JSON.stringify(newList));
    
    // Cleanup
    localStorage.removeItem(`${id}_days`);
    localStorage.removeItem(`${id}_exp`);
    localStorage.removeItem(`${id}_shop`);
    localStorage.removeItem(`${id}_shop_cats`);
    localStorage.removeItem(`${id}_users`);
    localStorage.removeItem(`${id}_rate`);
    localStorage.removeItem(`${id}_config`);

    if (currentTripId === id) {
      if (newList.length > 0) switchTrip(newList[0].id);
      else {
        setDays([]);
        setShoppingList([]);
        setCurrentTripId(null);
        setShowSetupModal(true);
      }
    }
  };

  const updateDate = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) return;
    
    const d = new Date(val);
    if (isNaN(d.getTime())) return;
    
    const w = ['日','一','二','三','四','五','六'][d.getDay()];
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    
    setDays(prev => {
      const next = [...prev];
      next[currentDayIdx] = {
        ...next[currentDayIdx],
        fullDate: val,
        date: `${mm < 10 ? '0'+mm : mm}/${dd < 10 ? '0'+dd : dd} (${w})`,
        shortDate: `${mm}/${dd}`
      };
      return next;
    });
  };

  const updateCurrentDay = (field: keyof DayPlan, value: any) => {
    setDays(prev => {
      const next = [...prev];
      next[currentDayIdx] = { ...next[currentDayIdx], [field]: value };
      return next;
    });
  };

  const addItem = () => {
    const newItem: TripItem = { time: '', type: 'spot', activity: '', location: '', note: '' };
    updateCurrentDay('items', [...currentDay.items, newItem]);
  };

  const updateItem = (idx: number, field: keyof TripItem, value: any) => {
    const newItems = [...currentDay.items];
    newItems[idx] = { ...newItems[idx], [field]: value };
    updateCurrentDay('items', newItems);
  };

  const removeItem = (idx: number) => {
    const newItems = [...currentDay.items];
    newItems.splice(idx, 1);
    updateCurrentDay('items', newItems);
  };

  const toggleFlightCard = () => {
    if (currentDay.flight) {
      if (confirm('移除航班?')) updateCurrentDay('flight', null);
    } else {
      updateCurrentDay('flight', { 
        startTime: '10:00', startAirport: 'TPE', number: 'FLIGHT', 
        endTime: '14:00', endAirport: 'DEST', arrivalOffset: 0 
      });
    }
  };

  const addExpense = () => {
    if (!newExpense.item) return;
    setExpenses(prev => [{ ...newExpense, amount: Number(newExpense.amount) }, ...prev]);
    setNewExpense(prev => ({ ...prev, item: '', amount: '' }));
  };

  const removeExpense = (idx: number) => {
    setExpenses(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleSettled = (idx: number) => {
    setExpenses(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], isSettled: !next[idx].isSettled };
      return next;
    });
  };

  // --- Shopping List Methods ---
  const addShoppingItem = () => {
    if (!newShoppingItem.name.trim()) return;
    const newItem: ShoppingItem = {
      id: generateId(),
      name: newShoppingItem.name.trim(),
      category: newShoppingItem.category,
      owner: newShoppingItem.owner,
      isBought: false
    };
    setShoppingList(prev => [newItem, ...prev]);
    setNewShoppingItem(prev => ({ ...prev, name: '' })); 
  };

  const toggleShoppingItem = (id: string) => {
    setShoppingList(prev => prev.map(item => 
      item.id === id ? { ...item, isBought: !item.isBought } : item
    ));
  };

  const removeShoppingItem = (id: string) => {
    setShoppingList(prev => prev.filter(item => item.id !== id));
  };
  
  const addShoppingCategory = () => {
    const cat = prompt("輸入新標籤名稱 (例如: 動漫周邊)");
    if (cat && !shoppingCategories.includes(cat)) {
      setShoppingCategories(prev => [...prev, cat]);
      setNewShoppingItem(prev => ({ ...prev, category: cat }));
    }
  };

  // --- API Calls ---

  const detectRate = async () => {
    if (!setup.destination) return;
    setIsRateLoading(true);
    try {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(setup.destination)}&limit=1&addressdetails=1`);
      const geoData = await geoRes.json();
      if (geoData?.[0]?.address?.country_code) {
        const info = countryInfoMap[geoData[0].address.country_code.toLowerCase()] || {c:'USD',l:'en',n:'英文'};
        setSetup(prev => ({ ...prev, currency: info.c, langCode: info.l, langName: info.n }));
        
        if (info.c === 'TWD') {
          setSetup(prev => ({ ...prev, rate: 1 }));
        } else {
          const rRes = await fetch(`https://api.exchangerate-api.com/v4/latest/${info.c}`);
          const rData = await rRes.json();
          if (rData?.rates?.TWD) {
             setSetup(prev => ({ ...prev, rate: rData.rates.TWD }));
          }
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsRateLoading(false);
    }
  };

  const fetchWeather = async (locName: string) => {
    try {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locName)}&limit=1`);
      const geoData = await geoRes.json();
      if (geoData?.[0]) {
        const { lat, lon } = geoData[0];
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`);
        const wData = await wRes.json();
        setWeather({
          temp: Math.round(wData.current_weather.temperature),
          icon: getWeatherIcon(wData.current_weather.weathercode),
          location: locName,
          daily: wData.daily
        });
      }
    } catch (e) {
      setWeather(prev => ({ ...prev, temp: null }));
    }
  };

  const searchNearby = async (item: TripItem, idx: number) => {
    if (!item.location) return;
    const key = `${currentDayIdx}-${idx}`;
    setSearchTargetIndex(key);
    setIsSearchingRecs(true);
    
    try {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(item.location)}&limit=1`);
      const geoData = await geoRes.json();
      
      if (geoData && geoData.length > 0) {
        const finalQuery = `restaurant near ${item.location}`;
        const searchRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(finalQuery)}&limit=4`);
        const searchData = await searchRes.json();
        
        const recs = searchData.map((place: any) => ({
          name: place.name || place.display_name.split(',')[0],
          location: place.name || place.display_name.split(',')[0]
        }));
        
        setRecommendations(prev => ({
          ...prev,
          [key]: recs.length > 0 ? recs : [{ name: '找不到推薦', location: item.location }]
        }));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSearchingRecs(false);
      setSearchTargetIndex('');
    }
  };

  // --- Computed ---

  const totalExpense = useMemo(() => expenses.reduce((sum, item) => {
    if (item.isSettled) return sum;
    return sum + item.amount;
  }, 0), [expenses]);
  
  const paidByPerson = useMemo(() => {
    const map: Record<string, number> = {};
    participants.forEach(p => map[p] = 0);
    expenses.forEach(e => {
      if (e.isSettled) return;
      if (map[e.payer] === undefined) map[e.payer] = 0;
      map[e.payer] += e.amount;
    });
    return map;
  }, [participants, expenses]);

  const settlementPlan = useMemo(() => {
    if (totalExpense === 0) return [];
    const average = totalExpense / participants.length;
    let balances = participants.map(p => ({ name: p, val: (paidByPerson[p] || 0) - average }));
    
    let debtors = balances.filter(b => b.val < -1).sort((a, b) => a.val - b.val);
    let creditors = balances.filter(b => b.val > 1).sort((a, b) => b.val - a.val);
    
    const result = [];
    let i = 0, j = 0;
    
    while (i < debtors.length && j < creditors.length) {
      let debtor = debtors[i];
      let creditor = creditors[j];
      let amount = Math.min(Math.abs(debtor.val), creditor.val);
      amount = Math.round(amount);
      
      if (amount > 0) result.push({ from: debtor.name, to: creditor.name, amount });
      
      debtor.val += amount;
      creditor.val -= amount;
      
      if (Math.abs(debtor.val) < 1) i++;
      if (creditor.val < 1) j++;
    }
    return result;
  }, [totalExpense, participants, paidByPerson]);

  const currencySymbol = useMemo(() => {
    const map: Record<string, string> = { 'JPY': '¥', 'CNY': '¥', 'USD': '$', 'EUR': '€', 'KRW': '₩', 'GBP': '£', 'TWD': 'NT$', 'HKD': 'HK$', 'THB': '฿' };
    return map[setup.currency] || '$';
  }, [setup.currency]);

  const weatherDisplay = useMemo(() => {
    if (!currentDay.fullDate || !weather.daily) {
      return { 
        temp: weather.temp !== null ? `${weather.temp}°` : '--', 
        icon: weather.icon, 
        label: `${setup.destination} (目前)`, 
        isForecast: false 
      };
    }
    const idx = weather.daily.time?.indexOf(currentDay.fullDate);
    if (idx !== undefined && idx !== -1) {
      const max = Math.round(weather.daily.temperature_2m_max[idx]);
      const min = Math.round(weather.daily.temperature_2m_min[idx]);
      return { 
        temp: `${min}° - ${max}°`, 
        icon: getWeatherIcon(weather.daily.weathercode[idx]), 
        label: `${setup.destination} (預報)`, 
        isForecast: true 
      };
    }
    return { 
      temp: weather.temp !== null ? `${weather.temp}°` : '--', 
      icon: weather.icon, 
      label: `${setup.destination} (目前)`, 
      isForecast: false 
    };
  }, [weather, currentDay, setup.destination]);

  // --- Map Effect ---

  useEffect(() => {
    if (viewMode !== 'map' || !currentDay) return;
    
    const timer = setTimeout(async () => {
      // @ts-ignore
      if (!window.L) return;
      
      if (!mapRef.current) {
        // @ts-ignore
        mapRef.current = window.L.map('map').setView([35.6895, 139.6917], 13);
        // @ts-ignore
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
          attribution: '© OpenStreetMap' 
        }).addTo(mapRef.current);
      }
      
      const map = mapRef.current;
      
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(pos => {
          const { latitude, longitude } = pos.coords;
          setUserLocation({ lat: latitude, lng: longitude });
          
          if (!userMarkerRef.current) {
             // @ts-ignore
             const icon = window.L.divIcon({ className: 'custom-div-icon', html: "<div class='gps-pulse'></div>", iconSize: [14, 14] });
             // @ts-ignore
             userMarkerRef.current = window.L.marker([latitude, longitude], { icon }).addTo(map);
          } else {
             userMarkerRef.current.setLatLng([latitude, longitude]);
          }
        });
      }

      map.eachLayer((layer: any) => {
        if (!layer._url) map.removeLayer(layer);
      });
      if (userMarkerRef.current) userMarkerRef.current.addTo(map);
      
      setIsMapLoading(true);
      // @ts-ignore
      const bounds = window.L.latLngBounds();
      let hasPoints = false;

      const locs = currentDay.items.filter(i => i.location);
      
      for (const item of locs) {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(item.location)}`);
          const d = await res.json();
          if (d && d.length > 0) {
            const lat = parseFloat(d[0].lat);
            const lon = parseFloat(d[0].lon);
            // @ts-ignore
            window.L.marker([lat, lon])
              .addTo(map)
              .bindPopup(`
                <div class="font-sans text-center">
                  <b class="text-sm block mb-1">${item.activity}</b>
                  <span class="text-xs opacity-70 block mb-2">${item.location}</span>
                  <div class="flex gap-2 justify-center">
                    <a href="https://map.naver.com/p/search/${encodeURIComponent(item.location)}" target="_blank" class="text-[#03C75A] font-bold text-xs border border-[#03C75A] px-2 py-0.5 rounded hover:bg-[#03C75A] hover:text-white transition">Naver</a>
                    <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}" target="_blank" class="text-blue-500 font-bold text-xs border border-blue-500 px-2 py-0.5 rounded hover:bg-blue-500 hover:text-white transition">Google</a>
                  </div>
                </div>
              `);
            bounds.extend([lat, lon]);
            hasPoints = true;
          }
        } catch(e) {}
      }
      
      setIsMapLoading(false);
      if (hasPoints) map.fitBounds(bounds, { padding: [50, 50] });

    }, 100);

    return () => clearTimeout(timer);
  }, [viewMode, currentDayIdx]);

  // --- Render ---

  return (
    <div className="flex flex-col h-full max-w-md mx-auto w-full bg-white shadow-2xl relative sm:rounded-xl sm:my-4 sm:h-[95vh] sm:border-4 sm:border-slate-100 font-sans">
      
      {/* Header */}
      <header className="bg-teal-600 text-white shrink-0 z-20 shadow-md">
        <div className="p-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => setShowTripMenu(true)} className="text-teal-100 hover:text-white transition">
              <i className="ph-bold ph-list text-2xl"></i>
            </button>
            <div className="overflow-hidden">
              <h1 className="text-xl font-bold tracking-wide flex items-center gap-2 truncate">
                {setup.destination || '旅遊計畫'} <i className="ph-fill ph-airplane-tilt text-sm opacity-70"></i>
              </h1>
              <p className="text-xs text-teal-100 mt-0.5 font-light tracking-wider truncate">點擊下方日期切換行程</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Share / Sync Button */}
            <button onClick={() => setShowCloudModal(true)} className={`p-2.5 rounded-xl transition-all h-11 w-11 flex items-center justify-center border border-teal-500/30 ${db ? 'bg-teal-500 text-white shadow-inner' : 'bg-teal-500/30 text-teal-200 hover:bg-teal-500/50'}`}>
               <i className={`ph-bold ${db ? (syncStatus === 'synced' ? 'ph-users' : 'ph-arrows-clockwise animate-spin') : 'ph-cloud-slash' } text-xl`}></i>
            </button>
            <div className="flex bg-teal-800/50 p-1 rounded-lg">
              <button onClick={() => setViewMode('plan')} className={`p-2 rounded-md transition-all ${viewMode === 'plan' ? 'bg-white text-teal-700 shadow-sm' : 'text-teal-200'}`}><i className="ph-bold ph-calendar-check text-lg"></i></button>
              <button onClick={() => setViewMode('map')} className={`p-2 rounded-md transition-all ${viewMode === 'map' ? 'bg-white text-teal-700 shadow-sm' : 'text-teal-200'}`}><i className="ph-bold ph-map-trifold text-lg"></i></button>
              <button onClick={() => setViewMode('money')} className={`p-2 rounded-md transition-all ${viewMode === 'money' ? 'bg-white text-teal-700 shadow-sm' : 'text-teal-200'}`}><i className="ph-bold ph-currency-dollar text-lg"></i></button>
              <button onClick={() => setViewMode('shopping')} className={`p-2 rounded-md transition-all ${viewMode === 'shopping' ? 'bg-white text-teal-700 shadow-sm' : 'text-teal-200'}`}><i className="ph-bold ph-shopping-cart text-lg"></i></button>
              <button onClick={() => setViewMode('translate')} className={`p-2 rounded-md transition-all ${viewMode === 'translate' ? 'bg-white text-teal-700 shadow-sm' : 'text-teal-200'}`}><i className="ph-bold ph-translate text-lg"></i></button>
            </div>
          </div>
        </div>
        <div className="flex overflow-x-auto hide-scroll px-2 pb-3 space-x-3 snap-x">
          {days.map((day, index) => (
            <div 
              key={index} 
              onClick={() => setCurrentDayIdx(index)} 
              className={`snap-center shrink-0 flex flex-col items-center justify-center w-16 h-16 rounded-xl cursor-pointer transition-all border-2 ${currentDayIdx === index ? 'bg-white text-teal-600 border-white shadow-lg scale-105' : 'bg-teal-500/50 text-teal-100 border-transparent hover:bg-teal-500'}`}
            >
              <span className="text-xs font-medium opacity-80">{day.shortDate}</span>
              <span className="text-lg font-bold">D{index + 1}</span>
            </div>
          ))}
          <button onClick={() => {
             const newDay = { 
               date: `Day ${days.length + 1}`, 
               shortDate: `D${days.length + 1}`, 
               fullDate: '', 
               title: '', 
               items: [], 
               flight: null 
             };
             setDays([...days, newDay]);
          }} className="shrink-0 w-12 h-16 rounded-xl flex items-center justify-center border-2 border-teal-400 border-dashed text-teal-200 hover:text-white hover:border-white transition">
            <i className="ph-bold ph-plus"></i>
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-y-auto bg-slate-50 relative hide-scroll">
        
        {/* View: Plan */}
        {viewMode === 'plan' && currentDay && (
          <div className="p-4 pb-24 animate-[fadeIn_0.3s_ease-out]">
            <div className="bg-white p-4 rounded-2xl shadow-sm mb-4 border border-slate-100 flex justify-between items-start">
              <div className="flex-1 relative pt-0.5">
                <input 
                  type="date" 
                  value={currentDay.fullDate} 
                  onChange={updateDate} 
                  className="absolute top-0 left-0 w-40 h-8 opacity-0 z-20 cursor-pointer" 
                />
                <div className="text-xl font-bold text-slate-800 bg-transparent border-none p-0 w-full relative z-10 pointer-events-none">
                   {currentDay.date || '點擊設定日期'}
                </div>
                <input 
                  value={currentDay.title} 
                  onChange={(e) => updateCurrentDay('title', e.target.value)} 
                  className="text-sm text-slate-500 bg-transparent border-b border-dashed border-slate-300 focus:border-teal-500 focus:outline-none w-full mt-1" 
                  placeholder="輸入當日主題" 
                />
              </div>
              <div className="flex flex-col items-end pl-2">
                <div className="text-right">
                  <div className="flex items-center justify-end gap-1 text-indigo-600">
                    <i className={`ph-duotone ${weatherDisplay.icon} text-2xl`}></i>
                    <span className="text-xl font-bold font-mono whitespace-nowrap">{weatherDisplay.temp}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 flex items-center gap-1 justify-end mt-0.5">
                    <i className={weatherDisplay.isForecast ? 'ph-bold ph-calendar' : 'ph-bold ph-map-pin'}></i>
                    {weatherDisplay.label}
                  </div>
                </div>
              </div>
            </div>

            {/* Flight Card */}
            <div className="mb-6">
              {currentDay.flight ? (
                <div className="relative bg-gradient-to-r from-blue-600 to-teal-500 rounded-2xl text-white shadow-lg overflow-hidden">
                   <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-slate-50 rounded-full z-10"></div>
                   <div className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-slate-50 rounded-full z-10"></div>
                   <div className="p-4 relative z-0">
                     <button onClick={toggleFlightCard} className="absolute top-2 right-2 text-white/50 hover:text-white hover:bg-white/20 rounded-full p-1 transition"><i className="ph-bold ph-x"></i></button>
                     <div className="flex justify-between items-center mb-1 pt-2">
                       <div className="flex flex-col items-center w-1/3">
                         <input 
                           type="time" 
                           value={currentDay.flight.startTime}
                           onChange={(e) => setDays(prev => {
                             const n = [...prev]; 
                             if(n[currentDayIdx].flight) n[currentDayIdx].flight!.startTime = e.target.value; 
                             return n;
                           })}
                           className="text-2xl font-black bg-transparent border-b border-white/30 w-full text-center text-white placeholder-white/50 focus:outline-none focus:border-white font-mono p-0" 
                         />
                         <div className="text-[9px] opacity-60 mt-1">起飛</div>
                         <input 
                           value={currentDay.flight.startAirport}
                           onChange={(e) => setDays(prev => {
                             const n = [...prev]; if(n[currentDayIdx].flight) n[currentDayIdx].flight!.startAirport = e.target.value; return n;
                           })}
                           className="text-sm font-bold opacity-90 bg-transparent border-none text-center w-full text-teal-100 placeholder-white/50 focus:ring-0 uppercase p-0" 
                           placeholder="TPE" 
                         />
                       </div>
                       <div className="flex flex-col items-center justify-center w-1/3 px-2">
                         <i className="ph-fill ph-airplane text-2xl mb-1 transform rotate-90"></i>
                         <input 
                           value={currentDay.flight.number}
                           onChange={(e) => setDays(prev => { const n=[...prev]; if(n[currentDayIdx].flight) n[currentDayIdx].flight!.number=e.target.value; return n; })}
                           className="text-[10px] font-mono tracking-widest opacity-80 bg-transparent border-none text-center w-full text-white placeholder-white/50 focus:ring-0 uppercase p-0" 
                           placeholder="BR198" 
                         />
                         <div className="w-full h-0.5 bg-white/30 rounded-full mt-1"></div>
                       </div>
                       <div className="flex flex-col items-center w-1/3">
                         <input 
                           type="time" 
                           value={currentDay.flight.endTime}
                           onChange={(e) => setDays(prev => { const n=[...prev]; if(n[currentDayIdx].flight) n[currentDayIdx].flight!.endTime=e.target.value; return n; })}
                           className="text-2xl font-black bg-transparent border-b border-white/30 w-full text-center text-white placeholder-white/50 focus:outline-none focus:border-white font-mono p-0" 
                         />
                         <div className="relative w-full mt-0.5">
                            <select 
                              value={currentDay.flight.arrivalOffset}
                              onChange={(e) => setDays(prev => { const n=[...prev]; if(n[currentDayIdx].flight) n[currentDayIdx].flight!.arrivalOffset=parseInt(e.target.value); return n; })}
                              className="appearance-none bg-black/20 text-white text-[9px] rounded border-none w-full py-0.5 px-1 text-center focus:ring-0 cursor-pointer hover:bg-black/30"
                            >
                              <option value="0" className="text-slate-800">同日抵達</option>
                              <option value="1" className="text-slate-800">+1天</option>
                              <option value="-1" className="text-slate-800">-1天</option>
                            </select>
                            {currentDay.flight.arrivalOffset !== 0 && (
                              <div className="absolute -top-8 right-0 bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded shadow font-bold animate-pulse">
                                {currentDay.flight.arrivalOffset > 0 ? '+1' : '-1'}
                              </div>
                            )}
                         </div>
                         <input 
                           value={currentDay.flight.endAirport}
                           onChange={(e) => setDays(prev => { const n=[...prev]; if(n[currentDayIdx].flight) n[currentDayIdx].flight!.endAirport=e.target.value; return n; })}
                           className="text-sm font-bold opacity-90 bg-transparent border-none text-center w-full text-teal-100 placeholder-white/50 focus:ring-0 uppercase p-0" 
                           placeholder="NRT" 
                         />
                       </div>
                     </div>
                   </div>
                </div>
              ) : (
                <button onClick={toggleFlightCard} className="w-full py-3 border-2 border-dashed border-slate-300 rounded-2xl text-slate-400 hover:border-teal-400 hover:text-teal-500 hover:bg-teal-50/50 transition flex items-center justify-center gap-2 group">
                  <i className="ph-bold ph-airplane-tilt text-lg group-hover:scale-110 transition-transform"></i>
                  <span className="text-sm font-bold">新增當日航班資訊</span>
                </button>
              )}
            </div>

            <div className="relative pl-4 border-l-2 border-teal-100 space-y-8">
              {currentDay.items.map((item, idx) => (
                <div key={idx} className="relative group">
                  <div className={`absolute -left-[21px] top-3 w-3 h-3 rounded-full border-2 border-white shadow-sm ${getDotColor(item.type)}`}></div>
                  <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-start gap-3">
                        <div className="flex flex-col items-center w-20 shrink-0 gap-2">
                          <div className="relative flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-1 w-full h-16 cursor-pointer hover:bg-teal-50 hover:border-teal-200 transition group/time">
                            <span className="text-[10px] font-medium text-slate-400 group-hover/time:text-teal-400">{getTimePeriod(item.time)}</span>
                            <span className="text-xl font-bold text-slate-700 group-hover/time:text-teal-600 leading-none font-mono tracking-tight">{item.time || '--:--'}</span>
                            <input 
                              type="time" 
                              value={item.time} 
                              onChange={(e) => updateItem(idx, 'time', e.target.value)} 
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
                            />
                          </div>
                          <select 
                            value={item.type} 
                            onChange={(e) => updateItem(idx, 'type', e.target.value)}
                            className="text-[10px] bg-white border border-slate-200 rounded-md py-1 px-1 w-full text-center"
                          >
                            <option value="spot">📍 景點</option>
                            <option value="food">🍴 美食</option>
                            <option value="shop">🛍️ 購物</option>
                            <option value="transport">🚇 交通</option>
                            <option value="flight">✈️ 航班</option>
                          </select>
                        </div>
                        <div className="flex-1 min-w-0 pt-1">
                          <input 
                            value={item.activity} 
                            onChange={(e) => updateItem(idx, 'activity', e.target.value)}
                            className="block w-full font-bold text-slate-800 bg-transparent border-none p-0 focus:ring-0" 
                            placeholder="行程名稱..." 
                          />
                          <div className="flex items-center gap-1 mt-1">
                            <i className="ph-fill ph-map-pin text-teal-400 text-xs"></i>
                            <input 
                              value={item.location} 
                              onChange={(e) => updateItem(idx, 'location', e.target.value)}
                              className="flex-1 text-xs text-slate-500 bg-transparent border-none p-0 focus:ring-0 truncate" 
                              placeholder="輸入地點 (例如: 新宿)" 
                            />
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <i className="ph-bold ph-info text-orange-400 text-xs"></i>
                            <input 
                              value={item.note} 
                              onChange={(e) => updateItem(idx, 'note', e.target.value)}
                              className="flex-1 text-xs text-orange-600/90 bg-transparent border-none p-0 focus:ring-0 truncate" 
                              placeholder="備註" 
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-2">
                          <a href={item.location ? `https://map.naver.com/p/search/${encodeURIComponent(item.location)}` : '#'} target="_blank" className="text-green-500 hover:bg-green-50 p-1 rounded flex items-center justify-center" title="Naver Map">
                             <div className="w-4 h-4 border-2 border-current rounded-sm flex items-center justify-center text-[10px] font-black font-sans">N</div>
                          </a>
                          <a href={item.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}` : '#'} target="_blank" className="text-teal-500 hover:bg-teal-50 p-1 rounded" title="Google Maps"><i className="ph-bold ph-navigation-arrow"></i></a>
                          <button onClick={() => removeItem(idx)} className="text-red-300 hover:text-red-500 p-1 rounded"><i className="ph-bold ph-trash"></i></button>
                        </div>
                      </div>
                      
                      {item.type === 'food' && (
                        <div className="p-2 bg-orange-50 rounded-lg border border-orange-100/50 mt-1">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[10px] font-bold text-orange-400 flex items-center gap-1">
                              <i className="ph-fill ph-fork-knife"></i> 美食推薦
                            </p>
                            <button 
                              onClick={() => searchNearby(item, idx)} 
                              disabled={!item.location}
                              className="text-[10px] text-teal-600 hover:text-teal-800 flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-teal-100 shadow-sm"
                            >
                              {isSearchingRecs && searchTargetIndex === `${currentDayIdx}-${idx}` ? (
                                <i className="ph-bold ph-spinner animate-spin"></i>
                              ) : (
                                <i className="ph-bold ph-magnifying-glass"></i>
                              )}
                              搜尋
                            </button>
                          </div>
                          
                          {recommendations[`${currentDayIdx}-${idx}`] && recommendations[`${currentDayIdx}-${idx}`].length > 0 ? (
                            <div className="flex flex-wrap gap-2 mt-1">
                              {recommendations[`${currentDayIdx}-${idx}`].map((rec, rIdx) => (
                                <button 
                                  key={rIdx} 
                                  onClick={() => {
                                      updateItem(idx, 'activity', rec.name);
                                      updateItem(idx, 'location', rec.name);
                                  }}
                                  className="text-[10px] px-2 py-1.5 bg-white border border-orange-200 rounded-lg text-slate-600 hover:bg-orange-500 hover:text-white hover:border-orange-500 transition shadow-sm flex flex-col items-start gap-0.5 max-w-[120px] truncate"
                                >
                                  <span className="font-bold truncate w-full text-left">{rec.name}</span>
                                </button>
                              ))}
                            </div>
                          ) : !item.location ? (
                            <div className="text-[9px] text-slate-400 italic">請先輸入地點，再點擊搜尋</div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={addItem} className="flex items-center gap-2 text-teal-400 hover:text-teal-600 text-sm font-medium px-2 py-1">
                <div className="w-2 h-2 bg-teal-300 rounded-full"></div>
                <i className="ph-bold ph-plus"></i> 新增行程
              </button>
            </div>
            
            <div className="mt-12 pt-6 border-t border-slate-200 text-center">
              <button 
                onClick={() => {
                   if (days.length > 1 && confirm('刪除這一天？')) {
                     const newDays = [...days];
                     newDays.splice(currentDayIdx, 1);
                     setDays(newDays);
                     if (currentDayIdx >= newDays.length) setCurrentDayIdx(newDays.length - 1);
                   }
                }} 
                className="text-xs text-red-300 hover:text-red-500 flex items-center justify-center gap-1 mx-auto"
              >
                <i className="ph-bold ph-trash"></i> 刪除這一天
              </button>
            </div>
          </div>
        )}

        {/* View: Map */}
        {viewMode === 'map' && (
          <div className="h-full flex flex-col relative animate-[fadeIn_0.3s_ease-out]">
             <div id="map" className="flex-1 w-full h-full bg-slate-200 z-0"></div>
             {isMapLoading && (
               <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-10 flex flex-col items-center justify-center text-teal-600">
                 <i className="ph-duotone ph-spinner animate-spin text-4xl mb-2"></i>
                 <span className="text-xs font-bold">讀取中...</span>
               </div>
             )}
             <div className="absolute bottom-4 left-4 right-4 bg-white/90 backdrop-blur rounded-xl p-3 shadow-lg border border-white/50 z-10 flex justify-between items-center">
                <div className="text-sm font-bold text-slate-800">📍 {currentDay?.items.filter(i => i.location).length} 個地點</div>
                <div className="flex gap-2">
                   <a 
                      href={`https://map.naver.com/p/search/${encodeURIComponent(setup.destination || '')}`} 
                      target="_blank"
                      rel="noreferrer"
                      className="w-10 h-10 bg-[#03C75A] text-white rounded-lg shadow-md flex items-center justify-center font-black font-sans text-lg hover:bg-[#02b351] transition"
                      title="開啟 Naver Map"
                   >
                      N
                   </a>
                   <button onClick={() => {
                      if (mapRef.current) mapRef.current.invalidateSize();
                   }} className="w-10 h-10 bg-teal-100 text-teal-600 rounded-lg flex items-center justify-center hover:bg-teal-200 transition"><i className="ph-bold ph-arrows-clockwise text-xl"></i></button>
                   <button onClick={() => {
                      if (userLocation && mapRef.current) mapRef.current.flyTo([userLocation.lat, userLocation.lng], 15);
                   }} className="w-10 h-10 bg-blue-500 text-white rounded-lg shadow-md flex items-center justify-center hover:bg-blue-600 transition"><i className="ph-bold ph-crosshair text-xl"></i></button>
                </div>
             </div>
          </div>
        )}

        {/* View: Money */}
        {viewMode === 'money' && (
          <div className="p-4 pb-24 animate-[fadeIn_0.3s_ease-out]">
            <div className="bg-teal-600 text-white rounded-2xl p-6 shadow-lg mb-6 text-center relative">
              <div className="absolute top-4 right-4 flex flex-col items-end">
                <label className="text-[10px] text-teal-200 mb-1">匯率 ({setup.currency})</label>
                <input 
                  type="number" 
                  step="0.001" 
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(parseFloat(e.target.value))}
                  className="w-16 text-right text-xs text-teal-900 rounded px-1 py-0.5" 
                />
              </div>
              <div className="text-sm opacity-80 mb-1">總支出 Total</div>
              <div className="text-4xl font-bold font-mono">{currencySymbol} {totalExpense.toLocaleString()}</div>
              <div className="text-lg font-bold text-teal-200 mt-1">≈ NT$ {Math.round(totalExpense * exchangeRate).toLocaleString()}</div>
            </div>

            <div className="mb-4 bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
              <div className="text-xs font-bold text-slate-400 mb-2">分帳成員 (逗號分隔)</div>
              <input 
                value={participantsStr}
                onChange={(e) => {
                  setParticipantsStr(e.target.value);
                  setParticipants(e.target.value.split(',').map(s => s.trim()).filter(Boolean));
                }}
                className="w-full text-sm bg-slate-50 rounded px-2 py-1 border border-slate-200" 
                placeholder="例如: 我, 朋友A, 朋友B" 
              />
            </div>

            <div className="grid grid-cols-2 gap-2 mb-6">
              {participants.map(p => (
                <div key={p} className="bg-white p-3 rounded-xl border border-slate-100 text-center shadow-sm">
                  <div className="text-xs text-slate-400 mb-1">{p} 墊付</div>
                  <div className="text-sm font-bold text-teal-600">{currencySymbol}{paidByPerson[p]?.toLocaleString() || 0}</div>
                </div>
              ))}
            </div>

            {settlementPlan.length > 0 && (
              <div className="bg-teal-50 rounded-xl p-4 mb-6 border border-teal-100">
                <h3 className="text-xs font-bold text-teal-400 uppercase tracking-wide mb-3">結帳建議</h3>
                <div className="space-y-2">
                   {settlementPlan.map((plan, idx) => (
                     <div key={idx} className="flex items-center justify-between text-sm bg-white p-2 rounded-lg shadow-sm">
                       <span className="font-bold text-slate-600">{plan.from} <i className="ph-bold ph-arrow-right text-xs"></i> {plan.to}</span>
                       <span className="font-mono font-bold text-teal-600">{currencySymbol}{plan.amount.toLocaleString()}</span>
                     </div>
                   ))}
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm p-4 mb-6 border border-slate-100">
              <div className="flex gap-2 mb-2">
                <input 
                  value={newExpense.item}
                  onChange={(e) => setNewExpense({ ...newExpense, item: e.target.value })}
                  placeholder="項目" 
                  className="w-[65%] bg-slate-50 border-none rounded-lg text-sm px-3 py-2" 
                />
                <select 
                  value={newExpense.payer}
                  onChange={(e) => setNewExpense({ ...newExpense, payer: e.target.value })}
                  className="flex-1 bg-slate-50 border-none rounded-lg text-sm px-2 py-2 min-w-0"
                >
                  {participants.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <input 
                  type="number"
                  value={newExpense.amount}
                  onChange={(e) => setNewExpense({ ...newExpense, amount: e.target.value })}
                  placeholder={`${currencySymbol} 金額`} 
                  className="w-full bg-slate-50 border-none rounded-lg text-sm pl-3 pr-3 py-2 font-mono" 
                />
                <button onClick={addExpense} className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded-lg font-bold"><i className="ph-bold ph-plus"></i></button>
              </div>
            </div>

            <div className="space-y-3">
              {expenses.map((exp, idx) => (
                <div key={idx} className={`flex justify-between items-center p-3 rounded-xl border shadow-sm transition-all ${exp.isSettled ? 'bg-slate-50 border-slate-100 opacity-60' : 'bg-white border-slate-100'}`}>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => toggleSettled(idx)}
                      className={`w-6 h-6 rounded-lg flex items-center justify-center border transition-colors shrink-0 ${exp.isSettled ? 'bg-slate-400 border-slate-400 text-white' : 'bg-white border-slate-200 text-transparent hover:border-teal-400'}`}
                      title="標記已結清 (不計入總額)"
                    >
                      <i className="ph-bold ph-check text-sm"></i>
                    </button>
                    <div className="w-8 h-8 rounded-full bg-teal-50 flex items-center justify-center text-teal-600 text-xs font-bold shrink-0">{exp.payer.charAt(0)}</div>
                    <div className={`font-bold text-sm ${exp.isSettled ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{exp.item}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-mono font-bold ${exp.isSettled ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{currencySymbol}{exp.amount.toLocaleString()}</span>
                    <button onClick={() => removeExpense(idx)} className="text-slate-300 hover:text-red-400"><i className="ph-fill ph-x-circle"></i></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* View: Shopping List */}
        {viewMode === 'shopping' && (
          <div className="p-4 pb-24 animate-[fadeIn_0.3s_ease-out]">
            <div className="bg-pink-500 text-white rounded-2xl p-6 shadow-lg mb-6 text-center relative overflow-hidden">
               <div className="absolute right-0 top-0 opacity-10">
                 <i className="ph-fill ph-shopping-cart text-9xl"></i>
               </div>
               <h2 className="text-2xl font-bold mb-1">購物清單</h2>
               <p className="text-pink-100 text-sm">別忘了買這些伴手禮！</p>
               <div className="mt-4 flex justify-center gap-4 text-sm font-bold">
                  <div>
                    <span className="text-2xl block">{shoppingList.filter(i => !i.isBought).length}</span>
                    <span className="opacity-70">待買</span>
                  </div>
                  <div className="w-px bg-white/30"></div>
                  <div>
                    <span className="text-2xl block">{shoppingList.filter(i => i.isBought).length}</span>
                    <span className="opacity-70">已買</span>
                  </div>
               </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-4 mb-6 border border-slate-100">
              <div className="flex gap-2 mb-3">
                <input 
                  value={newShoppingItem.name}
                  onChange={(e) => setNewShoppingItem({...newShoppingItem, name: e.target.value})}
                  onKeyDown={(e) => e.key === 'Enter' && addShoppingItem()}
                  placeholder="輸入想買的東西..." 
                  className="w-full bg-slate-50 border-none rounded-lg text-sm px-4 py-3 focus:ring-2 focus:ring-pink-400" 
                />
                <button onClick={addShoppingItem} className="bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-lg font-bold shadow-sm whitespace-nowrap"><i className="ph-bold ph-plus"></i></button>
              </div>
              
              <div className="flex flex-col gap-3">
                 {/* Category Selector */}
                 <div className="flex items-center gap-2 overflow-x-auto hide-scroll pb-1">
                    <span className="text-[10px] text-slate-400 font-bold shrink-0">分類:</span>
                    {shoppingCategories.map(cat => (
                      <button 
                        key={cat}
                        onClick={() => setNewShoppingItem({...newShoppingItem, category: cat})}
                        className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${newShoppingItem.category === cat ? 'bg-pink-100 text-pink-600 border border-pink-200' : 'bg-slate-50 text-slate-500 border border-slate-100 hover:bg-slate-100'}`}
                      >
                        {cat}
                      </button>
                    ))}
                    <button onClick={addShoppingCategory} className="px-2 py-1 rounded-full text-xs font-bold text-slate-400 border border-dashed border-slate-300 hover:border-pink-300 hover:text-pink-500 whitespace-nowrap">
                       <i className="ph-bold ph-plus"></i>
                    </button>
                 </div>

                 {/* Owner Selector */}
                 <div className="flex items-center gap-2 overflow-x-auto hide-scroll pb-1">
                    <span className="text-[10px] text-slate-400 font-bold shrink-0">誰要買:</span>
                    {participants.map(p => (
                      <button 
                        key={p}
                        onClick={() => setNewShoppingItem({...newShoppingItem, owner: p})}
                        className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${newShoppingItem.owner === p ? 'bg-teal-100 text-teal-700 border border-teal-200' : 'bg-slate-50 text-slate-500 border border-slate-100 hover:bg-slate-100'}`}
                      >
                        {p}
                      </button>
                    ))}
                 </div>
              </div>
            </div>

            <div className="space-y-3">
              {shoppingList.length === 0 && (
                <div className="text-center text-slate-400 py-10">
                  <i className="ph-duotone ph-basket text-4xl mb-2"></i>
                  <p className="text-sm">目前清單是空的</p>
                </div>
              )}
              {shoppingList.map((item) => (
                <div key={item.id} className={`flex items-start p-3 rounded-xl border shadow-sm transition-all group ${item.isBought ? 'bg-slate-50 border-slate-100' : 'bg-white border-slate-100'}`}>
                  <button 
                    onClick={() => toggleShoppingItem(item.id)}
                    className={`w-6 h-6 mt-0.5 rounded-lg flex items-center justify-center border transition-all shrink-0 mr-3 ${item.isBought ? 'bg-pink-400 border-pink-400 text-white' : 'bg-white border-slate-300 text-transparent hover:border-pink-400'}`}
                  >
                    <i className="ph-bold ph-check text-xs"></i>
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className={`font-bold text-sm transition-all mb-1 truncate ${item.isBought ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                      {item.name}
                    </div>
                    <div className="flex gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${item.isBought ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-pink-50 text-pink-600 border-pink-100'}`}>
                        {item.category || '未分類'}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${item.isBought ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-teal-50 text-teal-600 border-teal-100'}`}>
                        <i className="ph-fill ph-user"></i> {item.owner || '我'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => removeShoppingItem(item.id)} className="text-slate-300 hover:text-red-400 p-2"><i className="ph-fill ph-trash"></i></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* View: Translate */}
        {viewMode === 'translate' && (
          <div className="p-6 h-full flex flex-col justify-center items-center pb-32 animate-[fadeIn_0.3s_ease-out]">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-slate-800 mb-2">Google 翻譯捷徑</h2>
              <p className="text-sm text-slate-400">請選擇您需要的翻譯模式</p>
            </div>
            <div className="w-full mb-4">
              <a href="https://translate.google.com/?op=images" target="_blank" rel="noreferrer" className="block w-full">
                <button className="w-full bg-gradient-to-br from-orange-400 to-red-500 text-white rounded-2xl p-6 shadow-lg active:scale-95 transition-transform relative overflow-hidden group">
                  <div className="relative z-10 flex items-center justify-between">
                    <div className="text-left">
                      <div className="text-xs opacity-80 mb-1 tracking-wider">菜單 / 看板</div>
                      <div className="text-2xl font-bold">照相翻譯 <i className="ph-bold ph-camera text-sm"></i></div>
                    </div>
                    <i className="ph-duotone ph-camera-plus text-3xl opacity-60 group-hover:opacity-100"></i>
                  </div>
                </button>
              </a>
            </div>
            <div className="w-full mb-4">
              <a href={`https://translate.google.com/?sl=zh-TW&tl=${setup.langCode}&op=translate`} target="_blank" rel="noreferrer" className="block w-full">
                <button className="w-full bg-gradient-to-br from-indigo-500 to-blue-600 text-white rounded-2xl p-6 shadow-lg active:scale-95 transition-transform relative overflow-hidden group">
                   <div className="relative z-10 flex items-center justify-between">
                     <div className="text-left">
                       <div className="text-xs opacity-80 mb-1 tracking-wider">我說中文 (轉{setup.langName})</div>
                       <div className="text-2xl font-bold">CH <i className="ph-bold ph-arrow-right text-sm"></i> {setup.langCode.toUpperCase()}</div>
                     </div>
                     <i className="ph-duotone ph-arrow-square-out text-3xl opacity-60 group-hover:opacity-100"></i>
                   </div>
                </button>
              </a>
            </div>
            <div className="w-full">
               <a href={`https://translate.google.com/?sl=${setup.langCode}&tl=zh-TW&op=translate`} target="_blank" rel="noreferrer" className="block w-full">
                 <button className="w-full bg-white border-2 border-slate-200 text-slate-700 rounded-2xl p-6 shadow-sm active:scale-95 transition-transform relative overflow-hidden group hover:border-indigo-300">
                    <div className="relative z-10 flex items-center justify-between">
                      <div className="text-left">
                        <div className="text-xs text-slate-400 mb-1 tracking-wider">對方說{setup.langName} (轉中文)</div>
                        <div className="text-2xl font-bold font-jp">{setup.langCode.toUpperCase()} <i className="ph-bold ph-arrow-right text-sm"></i> CH</div>
                      </div>
                      <i className="ph-duotone ph-arrow-square-out text-3xl text-slate-300 group-hover:text-indigo-500 transition-colors"></i>
                    </div>
                 </button>
               </a>
            </div>
          </div>
        )}
      </main>

      {/* Sidebar: Trip Menu */}
      {showTripMenu && (
        <div className="fixed inset-0 z-50 flex">
          <div className="bg-white w-4/5 max-w-xs h-full shadow-2xl flex flex-col relative z-50 p-6 animate-[slideIn_0.3s_ease-out]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800">我的旅程</h2>
              <button onClick={() => setShowTripMenu(false)} className="text-slate-400 hover:text-slate-600"><i className="ph-bold ph-x text-xl"></i></button>
            </div>
            <button 
              onClick={() => { setSetup(defaultSetup); setShowSetupModal(true); setShowTripMenu(false); }} 
              className="w-full py-3 mb-6 border-2 border-dashed border-teal-400 text-teal-600 rounded-xl font-bold hover:bg-teal-50 flex items-center justify-center gap-2"
            >
              <i className="ph-bold ph-plus-circle"></i> 建立新旅程
            </button>
            <div className="flex-1 overflow-y-auto space-y-3 hide-scroll">
               {tripList.map(trip => (
                 <div 
                   key={trip.id} 
                   onClick={() => switchTrip(trip.id)}
                   className={`p-4 rounded-xl border transition cursor-pointer relative group ${currentTripId === trip.id ? 'bg-teal-50 border-teal-500 shadow-sm' : 'bg-slate-50 border-transparent hover:bg-slate-100'}`}
                 >
                   <div className="font-bold text-slate-800">{trip.destination || '未命名行程'}</div>
                   <div className="text-xs text-slate-400 mt-1">{trip.startDate} • {trip.daysCount} 天</div>
                   <button 
                     onClick={(e) => deleteTrip(trip.id, e)} 
                     className="absolute right-2 top-2 text-slate-300 hover:text-red-500 p-2 rounded-full hover:bg-red-50 transition-colors z-10"
                   >
                     <i className="ph-bold ph-trash text-lg"></i>
                   </button>
                 </div>
               ))}
            </div>
          </div>
          <div className="flex-1 bg-black/50 backdrop-blur-sm z-40" onClick={() => setShowTripMenu(false)}></div>
        </div>
      )}

      {/* Modal: Setup */}
      {showSetupModal && (
        <div className="absolute inset-0 bg-teal-800/90 backdrop-blur-sm z-50 flex items-center justify-center p-6 animate-[fadeIn_0.4s_ease-out]">
           <div className="bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative">
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-teal-100 rounded-full flex items-center justify-center mx-auto mb-3"><i className="ph-duotone ph-airplane-tilt text-3xl text-teal-600"></i></div>
                <h2 className="text-2xl font-bold text-slate-800">建立新旅程</h2>
                <p className="text-sm text-slate-400">簡單幾步，開始規劃您的冒險！</p>
              </div>
              <div className="space-y-4">
                 <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">目的地 (英文/中文)</label>
                    <div className="relative">
                       <input 
                         value={setup.destination} 
                         onChange={(e) => setSetup({ ...setup, destination: e.target.value })}
                         onBlur={detectRate}
                         placeholder="例如: Tokyo, Osaka" 
                         className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-700 focus:ring-2 focus:ring-teal-500 font-bold" 
                       />
                       <button onClick={detectRate} className="absolute right-3 top-3 text-teal-500 hover:text-teal-700"><i className="ph-bold ph-magnifying-glass"></i></button>
                    </div>
                 </div>
                 <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                       <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">開始日期</label>
                       <input 
                         type="date" 
                         value={setup.startDate} 
                         onChange={(e) => setSetup({ ...setup, startDate: e.target.value })}
                         className="h-12 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 text-slate-700 focus:ring-2 focus:ring-teal-500 text-sm" 
                       />
                    </div>
                    <div>
                       <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">天數</label>
                       <input 
                         type="number" 
                         min="1" max="30"
                         value={setup.days}
                         onChange={(e) => setSetup({ ...setup, days: parseInt(e.target.value) })}
                         className="h-12 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 text-slate-700 focus:ring-2 focus:ring-teal-500 text-center font-bold" 
                       />
                    </div>
                 </div>
                 <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1 ml-1 flex justify-between">
                       <span>匯率 ({setup.currency}:台幣)</span>
                       {isRateLoading && <span className="text-teal-500 animate-pulse">抓取中...</span>}
                    </label>
                    <input 
                      type="number" step="0.001"
                      value={setup.rate}
                      onChange={(e) => setSetup({ ...setup, rate: parseFloat(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-700 focus:ring-2 focus:ring-teal-500 font-mono text-right" 
                    />
                 </div>
                 <button onClick={createTrip} className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold py-3.5 rounded-xl shadow-lg transform active:scale-95 transition flex items-center justify-center gap-2 mt-2">
                    開始規劃 <i className="ph-bold ph-arrow-right"></i>
                 </button>
                 {tripList.length > 0 && (
                    <button onClick={() => setShowSetupModal(false)} className="w-full text-slate-400 text-xs py-2 hover:text-slate-600">取消</button>
                 )}
              </div>
           </div>
        </div>
      )}

      {/* Modal: Cloud Sync */}
      {showCloudModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6 animate-[fadeIn_0.2s_ease-out]">
          <div className="bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative">
            <button onClick={() => setShowCloudModal(false)} className="absolute right-4 top-4 text-slate-300 hover:text-slate-500"><i className="ph-bold ph-x text-xl"></i></button>
            
            <div className="flex flex-col items-center mb-6">
              <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-3 transition-colors ${db ? 'bg-green-100 text-green-600' : 'bg-slate-100 text-slate-400'}`}>
                <i className={`ph-duotone ${db ? 'ph-cloud-check' : 'ph-cloud-slash'} text-3xl`}></i>
              </div>
              <h2 className="text-xl font-bold text-slate-800">雲端同步與共享</h2>
              <div className="flex items-center gap-2 mt-1">
                 <div className={`w-2 h-2 rounded-full ${syncStatus === 'synced' ? 'bg-green-500' : syncStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`}></div>
                 <span className="text-xs text-slate-500 font-bold">
                    {syncStatus === 'synced' ? '已連線 Firebase' : syncStatus === 'connecting' ? '連線中...' : '尚未連線或錯誤'}
                 </span>
              </div>
            </div>

            {syncStatus === 'error' ? (
              <div className="space-y-4">
                <p className="text-xs text-red-500 leading-relaxed bg-red-50 p-3 rounded-xl border border-red-100">
                  連線失敗。請確認您的 Firebase 設定是否正確，或網路是否正常。
                </p>
                <textarea 
                  value={firebaseConfigStr}
                  onChange={(e) => setFirebaseConfigStr(e.target.value)}
                  placeholder='{ "apiKey": "...", "authDomain": "...", ... }'
                  className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-mono focus:ring-2 focus:ring-teal-500 outline-none resize-none"
                ></textarea>
                <button onClick={handleConnectCloud} className="w-full bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-slate-700 transition">
                  重試連線
                </button>
              </div>
            ) : syncStatus === 'synced' ? (
              <div className="space-y-6">
                <div className="bg-teal-50 p-4 rounded-xl border border-teal-100 text-center">
                  <div className="flex items-center justify-center gap-2 mb-1">
                      <div className="text-xs text-teal-600 font-bold">當前行程 ID</div>
                      <button onClick={copyShareLink} className="bg-teal-100 hover:bg-teal-200 text-teal-700 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1 transition-colors">
                          <i className="ph-bold ph-link"></i> 複製邀請連結
                      </button>
                  </div>
                  <div className="text-2xl font-black font-mono tracking-widest text-teal-800 select-all cursor-pointer" onClick={() => { navigator.clipboard.writeText(currentTripId || ''); alert('已複製 ID'); }}>
                    {currentTripId}
                  </div>
                  <div className="text-[10px] text-teal-400 mt-2 flex items-center justify-center gap-1">
                    <i className="ph-bold ph-check-circle"></i> 已與雲端即時同步
                  </div>
                </div>

                <div>
                   <div className="flex items-center gap-2 mb-2">
                     <div className="h-px bg-slate-200 flex-1"></div>
                     <span className="text-xs font-bold text-slate-400">加入其他行程</span>
                     <div className="h-px bg-slate-200 flex-1"></div>
                   </div>
                   <div className="flex gap-2">
                     <input 
                       value={joinTripId}
                       onChange={(e) => setJoinTripId(e.target.value)}
                       placeholder="輸入朋友的行程 ID..." 
                       className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none" 
                     />
                     <button onClick={() => joinTrip()} className="bg-teal-600 text-white px-4 py-2 rounded-xl font-bold hover:bg-teal-700">
                       加入
                     </button>
                   </div>
                </div>
                
                <div className="text-[10px] text-center text-slate-300">
                   User ID: {userUid?.substring(0, 8)}...
                </div>
              </div>
            ) : (
                <div className="text-center py-4">
                    <i className="ph-duotone ph-spinner animate-spin text-3xl text-teal-500 mb-2"></i>
                    <p className="text-sm text-slate-500">正在連線至雲端伺服器...</p>
                </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
