import axios from "axios";

const API = axios.create({
  baseURL: "http://localhost:3000/api",
});

API.interceptors.request.use((config) => {
  const token = localStorage.getItem("notifly_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const register = async (data) => {
  const res = await API.post("/auth/register", data);
  return res.data;
};

export const login = async (data) => {
  const res = await API.post("/auth/login", data);
  return res.data;
};

export const sendEvent = async (data) => {
  const res = await API.post("/events", data);
  return res.data;
};

export default API;