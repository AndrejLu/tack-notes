import React from 'react'
import { createRoot } from 'react-dom/client'
import { SetupApp } from './SetupApp'
import '../styles/base.css'
import './setup.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SetupApp />
  </React.StrictMode>
)
