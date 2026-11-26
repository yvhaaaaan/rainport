// A chassis keeps its livery when it changes owners. A borrowed car has its own
// fleet colour and shares the same body and standard hardware.
const chassisColors=[0x258d82,0x4779b4,0xb24f49,0x7461a0,0x467fa9,0x9b843e];
const borrowedColor=0xed733d;
const standardParts=[1,3,5];

function carAppearance(config,spec=standardParts){
 const serial=Number(config?.[0]);
 const chassisId=Number.isSafeInteger(serial)&&serial>0?serial:0;
 return {chassisId,color:chassisId?chassisColors[(chassisId-1)%chassisColors.length]:borrowedColor,
  plate:chassisId?'#'+String(chassisId).padStart(3,'0'):'借用',spec};
}

export {carAppearance};
