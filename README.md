# 💬 NexChat — Messagerie Instantanée

Application de chat temps réel entre appareils, déployable gratuitement sur **GitHub Pages**.

## ✨ Fonctionnalités

- 🔐 **Authentification** — Inscription / Connexion avec mots de passe
- 👑 **Rôles Admin** — Gestion complète des groupes et membres
- 💬 **Groupes de discussion** — Création, gestion, exclusion de membres
- 📩 **Messages privés** — Entre n'importe quels membres
- 😊 **Réactions emoji** — Sur chaque message
- ⌨️ **Indicateur de frappe** — Temps réel
- 🔔 **Notifications** — Via l'API navigateur
- 📱 **Responsive** — Compatible mobile

## 🚀 Déploiement sur GitHub Pages

### 1. Créer un dépôt GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON-USERNAME/nexchat.git
git push -u origin main
```

### 2. Activer GitHub Pages

1. Aller dans **Settings** → **Pages**
2. Source : **Deploy from a branch**
3. Branch : **main** / **(root)**
4. Cliquer sur **Save**

Ton site sera disponible à : `https://TON-USERNAME.github.io/nexchat`

## 📱 Communication entre appareils

L'application utilise **localStorage** pour stocker les données. Pour une vraie communication multi-appareils, deux approches :

### Option A : Même navigateur / onglets
Fonctionne immédiatement via `BroadcastChannel` et `localStorage`.

### Option B : Vrais appareils différents
Ajouter un backend comme **Firebase Realtime Database** (gratuit) :

1. Créer un projet sur [firebase.google.com](https://firebase.google.com)
2. Remplacer les fonctions `DB.get/set` pour utiliser Firebase
3. Exemple d'intégration dans `app.js`

## 🔑 Compte Admin par défaut

| Champ | Valeur |
|-------|--------|
| Utilisateur | `admin` |
| Mot de passe | `admin123` |

> ⚠️ Changer le mot de passe après le premier accès !

## 📁 Structure des fichiers

```
nexchat/
├── index.html    # Structure HTML
├── style.css     # Styles (thème sombre)
├── app.js        # Logique JavaScript
└── README.md     # Documentation
```

## 🛠️ Personnalisation

- **Couleurs** : Modifier les variables CSS dans `:root` dans `style.css`
- **Groupes par défaut** : Modifier `initDefaultData()` dans `app.js`
- **Logo** : Remplacer `.logo-icon` dans le HTML

## 📜 Licence

MIT — Libre d'utilisation et modification.
