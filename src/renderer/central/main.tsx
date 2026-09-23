import React from 'react'
import { createRoot } from 'react-dom/client'
import { CentralApp } from './CentralApp'
import '../styles/base.css'
import './central.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CentralApp />
  </React.StrictMode>
)
