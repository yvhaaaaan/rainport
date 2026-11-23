import {launch} from './server.mjs';
const h=await launch({listen:false,showcase:false});
try{console.log(JSON.stringify({chainId:31337,contracts:h.meta,wallets:h.wallets},null,2))}finally{await h.stop()}
