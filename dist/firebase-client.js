import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import { firebaseConfig } from './firebase-config.js';
initializeApp(firebaseConfig);
document.documentElement.dataset.firebaseProject = firebaseConfig.projectId;
