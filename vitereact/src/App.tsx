import React from "react";
import { Route, Routes } from "react-router-dom";
import cofounder from "@/assets/cofounder.webp";

const App: React.FC = () => {
	return (
		<>
			<div className="container mx-auto w-full xl:w-[60vw] p-12 mt-12 text-left whitespace-pre-line break-words">
				<section className="pb-4 mb-4 text-center">
					
					<h1 className="mt-8 text-2xl">Vite + React</h1>
					<h1 className="mt-2">your app will update here as it generates</h1>
				</section>
			</div>
		</>
	);
};

export default App;
