import { Navbar } from "@/components/Navbar";
import { Hero } from "@/components/sections/Hero";
import { Problem } from "@/components/sections/Problem";
import { Solution } from "@/components/sections/Solution";
import { Guardian } from "@/components/sections/Guardian";
import { Care } from "@/components/sections/Care";
import { Wellness } from "@/components/sections/Wellness";
import { Finance } from "@/components/sections/Finance";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { FamilyConnection } from "@/components/sections/FamilyConnection";
import { InteractiveShowcase } from "@/components/sections/InteractiveShowcase";
import { TechnologyShowcase } from "@/components/sections/TechnologyShowcase";
import { Team } from "@/components/sections/Team";
import { Vision } from "@/components/sections/Vision";
import { FinalCTA } from "@/components/sections/FinalCTA";
import { Footer } from "@/components/sections/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main id="main">
        <Hero />
        <Problem />
        <Solution />
        <Guardian />
        <Care />
        <Wellness />
        <Finance />
        <HowItWorks />
        <FamilyConnection />
        <InteractiveShowcase />
        <TechnologyShowcase />
        <Team />
        <Vision />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
