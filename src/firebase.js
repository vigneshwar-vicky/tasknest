import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCkDCGdAHT2o0cF6e-S7AvniPs0OlChYAw",
  authDomain: "tasknest-472c2.firebaseapp.com",
  projectId: "tasknest-472c2",
  storageBucket: "tasknest-472c2.firebasestorage.app",
  messagingSenderId: "125532963560",
  appId: "1:125532963560:web:f9797b80b4f3e5304bff5d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);