import { transformExtent } from 'ol/proj';
const radius=6371008.8, radians=Math.PI/180, latitude=37, longitude=114.05;
const dy=60000/radius/radians,dx=Math.asin(Math.sin(60000/radius)/Math.cos(latitude*radians))/radians;
export const SITUATION_AREA_BOUNDS:[number,number,number,number]=[longitude-dx,latitude-dy,longitude+dx,latitude+dy];
export const situationAreaExtent=()=>transformExtent(SITUATION_AREA_BOUNDS,'EPSG:4326','EPSG:3857');
