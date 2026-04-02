import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// 🔥 CONFIG FIREBASE (remplace par tes valeurs)
const firebaseConfig = {
  apiKey: "AIzaSyA-tFXKuWSUvzt0WJEBfXxaDxC0ZyD0dY8",
  authDomain: "nextschats.firebaseapp.com",
  projectId: "nextschats",
  storageBucket: "nextschats.firebasestorage.app",
  messagingSenderId: "1046541879556",
  appId: "1:1046541879556:web:de1c4b5f797daf95252851",
  measurementId: "G-PJDXX0ZJ5V"
};

// init Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 📩 ENVOYER MESSAGE
window.sendMessage = async function () {
  const input = document.getElementById("message-input");

  if (!input.value.trim()) return;

  await addDoc(collection(db, "messages"), {
    content: input.value,
    timestamp: Date.now()
  });

  input.value = "";
};

// 📡 RECEVOIR MESSAGES EN TEMPS RÉEL
const q = query(collection(db, "messages"), orderBy("timestamp"));

onSnapshot(q, (snapshot) => {
  const container = document.getElementById("messages-list");

  if (!container) return;

  container.innerHTML = "";

  snapshot.forEach((doc) => {
    const msg = doc.data();

    const div = document.createElement("div");
    div.className = "message"; // garde ton style
    div.textContent = msg.content;

    container.appendChild(div);
  });

  // scroll en bas
  container.scrollTop = container.scrollHeight;
});
