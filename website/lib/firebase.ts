import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBANJWl76DuMwb3ci2i_4WWrXniCbqowLs",
  authDomain: "spectra-59160.firebaseapp.com",
  projectId: "spectra-59160",
  storageBucket: "spectra-59160.firebasestorage.app",
  messagingSenderId: "583704444265",
  appId: "1:583704444265:web:75db7a2c41ed6b301391f8",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
