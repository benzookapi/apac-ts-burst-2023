import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Provider, NavigationMenu } from '@shopify/app-bridge-react';
import { AppProvider } from '@shopify/polaris';

import '@shopify/polaris/build/esm/styles.css';

import Index from './pages/Index';

import { _getAdminFromShop, _getShopFromQuery } from "./utils/my_util";

const config = {
  apiKey: API_KEY,
  host: new URLSearchParams(window.location.search).get("host"),
  forceRedirect: true
};

if (config.host == null) {
  console.log(`The config.host is null, being set from 'shop'.`);
  config.host = window.btoa(_getAdminFromShop(_getShopFromQuery(window))).replace(/=/g, '');
}

console.log(`AppBrige settings: config.apiKey [${config.apiKey}] config.host [${config.host}] config.forceRedirect [${config.forceRedirect}]`);

function App() {
  return (
    <Provider config={config}>
      <AppProvider i18n={{      }}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </Provider>
  );
}

export default App